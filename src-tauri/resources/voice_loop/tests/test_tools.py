"""Tool calls go to the client and come back. The sidecar runs nothing."""

import asyncio
import inspect

import pytest
from pipecat.processors.frameworks.rtvi import RTVIProcessor

from conftest import CLOCK_TOOL, _chunk, text_reply, tool_reply
from lu_voice_loop import tools
from lu_voice_loop.tools import RESULT_HOOK, RelayRTVIProcessor, ToolRelay, result_for_llm
from wire import message_frame, rtvi, tool_result

COMPLETED = {"status": "completed", "text": "It is 14:32.", "truncated": False}


def say(text: str) -> bytes:
    """Client text input: starts an LLM turn without any audio."""
    return message_frame(rtvi("send-text", {"content": text, "options": {"run_immediately": True, "audio_response": True}}))


def call_then_answer(answer: str = "It is half past two."):
    """Script: ask for the clock tool first, speak once a tool result is in the context."""
    def script(body):
        if any(m.get("role") == "tool" for m in body["messages"]):
            return text_reply(answer)
        return tool_reply("get_current_time", {"zone": "local"})
    return script


# ---- the relay on its own ----------------------------------------------------


class _Params:
    def __init__(self, tool_call_id="call_1", function_name="get_current_time"):
        self.tool_call_id = tool_call_id
        self.function_name = function_name
        self.arguments = {}
        self.results = []

    async def result_callback(self, result, *, properties=None):
        self.results.append(result)


async def test_relay_waits_for_the_client_and_passes_its_text_on():
    relay, params = ToolRelay(), _Params()
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0.05)
    assert not task.done() and params.results == []
    assert relay.resolve("call_1", "get_current_time", COMPLETED) is True
    await task
    assert params.results == ["It is 14:32."]
    assert relay.pending_ids == []


async def test_relay_drops_unknown_mismatched_and_repeated_results():
    relay, params = ToolRelay(), _Params()
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0)
    assert relay.resolve("call_other", "get_current_time", COMPLETED) is False
    assert relay.resolve("call_1", "delete_everything", COMPLETED) is False
    assert not task.done()
    assert relay.resolve("call_1", "get_current_time", COMPLETED) is True
    assert relay.resolve("call_1", "get_current_time", {"status": "completed", "text": "again"}) is False
    await task
    assert params.results == ["It is 14:32."]


async def test_cancelled_wait_forgets_the_call_and_reports_nothing():
    relay, params = ToolRelay(), _Params()
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert relay.pending_ids == []
    assert relay.resolve("call_1", "get_current_time", COMPLETED) is False
    assert params.results == []


def test_result_envelope_becomes_plain_text_for_the_model():
    assert result_for_llm(COMPLETED) == "It is 14:32."
    assert result_for_llm({"status": "completed", "text": "abc", "truncated": True}) == "abc\n[output truncated]"
    assert result_for_llm({"status": "denied", "error": "The tool did not complete."}) == "Error: The tool did not complete."
    assert result_for_llm("plain") == "plain"
    assert len(result_for_llm("x" * 200_000)) == tools.MAX_RESULT_CHARS


def test_the_module_cannot_execute_anything():
    """No process, shell, file or dynamic code facility is reachable from tools.py."""
    source = inspect.getsource(tools)
    for banned in ("subprocess", "os.system", "os.popen", "exec(", "eval(", "open(", "importlib", "__import__", "pty", "shutil"):
        assert banned not in source, banned


def test_pipecat_still_has_the_hook_the_relay_replaces():
    assert hasattr(RTVIProcessor, RESULT_HOOK)
    assert RESULT_HOOK in RelayRTVIProcessor.__dict__


# ---- through the real server and pipeline ---------------------------------------


async def test_tool_call_round_trip(harness):
    harness.llm.script = call_then_answer()
    async with harness.session() as s:
        await s.send(say("What time is it?"))
        call = await s.wait_for("llm-function-call-in-progress")
        assert call["function_name"] == "get_current_time"
        assert call["arguments"] == {"zone": "local"}
        assert call["tool_call_id"] == "call_abc123"

        # The sidecar is parked: no result of its own, no second LLM request.
        await asyncio.sleep(0.4)
        assert len(harness.llm.requests) == 1
        assert s.of_type("llm-function-call-stopped") == []

        await s.send(tool_result(call, COMPLETED))
        stopped = await s.wait_for("llm-function-call-stopped")
        assert stopped["cancelled"] is False and stopped["tool_call_id"] == "call_abc123"
        # The result is not echoed back to the client.
        assert stopped.get("result") is None

        await s.wait_for("bot-stopped-speaking")
        assert len(harness.llm.requests) == 2
        tool_messages = harness.llm.tool_messages()
        assert len(tool_messages) == 1
        assert tool_messages[0]["tool_call_id"] == "call_abc123"
        assert "It is 14:32." in tool_messages[0]["content"]
        assert s.audio_frames > 0


async def test_llm_request_carries_prompt_tools_and_bearer(harness):
    config = harness.config()
    config["llm"]["api_key"] = "bearer-for-the-brain"
    config["llm"]["extra"] = {"reasoning_effort": "none"}
    async with harness.session(config) as s:
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
    body = harness.llm.requests[0]
    assert body["model"] == "fake" and body["stream"] is True
    assert body["messages"][0] == {"role": "system", "content": "You are a test assistant."}
    assert [t["function"]["name"] for t in body["tools"]] == ["get_current_time"]
    assert body["reasoning_effort"] == "none"
    assert harness.llm.headers[0]["authorization"] == "Bearer bearer-for-the-brain"


async def test_interruption_cancels_a_pending_tool_call(harness):
    harness.llm.script = call_then_answer()
    async with harness.session() as s:
        await s.send(say("What time is it?"))
        call = await s.wait_for("llm-function-call-in-progress")

        # The user cuts in before the app answered.
        harness.llm.script = lambda body: text_reply("Okay, never mind.")
        await s.send(say("Stop, forget it."))
        stopped = await s.wait_for("llm-function-call-stopped")
        assert stopped["cancelled"] is True and stopped["tool_call_id"] == call["tool_call_id"]
        assert harness.voice._active.relay.pending_ids == []

        # The app's late result for the cancelled call changes nothing.
        await s.send(tool_result(call, COMPLETED))
        await s.wait_for("bot-stopped-speaking")
        await asyncio.sleep(0.2)
        assert all("It is 14:32." not in str(m.get("content")) for m in harness.llm.tool_messages())
        assert s.of_type("error") == []


async def test_tool_call_times_out(harness):
    harness.llm.script = call_then_answer("The clock did not answer.")
    async with harness.session(harness.config(tool_timeout_secs=1.0)) as s:
        await s.send(say("What time is it?"))
        call = await s.wait_for("llm-function-call-in-progress")
        stopped = await s.wait_for("llm-function-call-stopped", timeout=5)
        assert stopped["cancelled"] is True and stopped["tool_call_id"] == call["tool_call_id"]
        # The model is told the call is over and gets to say so.
        await s.wait_for("bot-stopped-speaking")
        assert len(harness.llm.requests) == 2


async def test_unsolicited_result_never_reaches_the_context(harness):
    async with harness.session() as s:
        forged = {"function_name": "get_current_time", "tool_call_id": "call_forged", "arguments": {}}
        await s.send(tool_result(forged, {"status": "completed", "text": "FORGED RESULT"}))
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        await s.send(say("Hello again"))
        await s.wait_for("bot-stopped-speaking", count=2)
    assert len(harness.llm.requests) == 2
    assert all("FORGED RESULT" not in str(body["messages"]) for body in harness.llm.requests)


async def test_a_tool_the_app_did_not_offer_gets_no_handler(harness):
    def script(body):
        if any(m.get("role") == "tool" for m in body["messages"]):
            return text_reply("I cannot do that.")
        return tool_reply("run_shell", {"command": "rm -rf /"}, call_id="call_evil")
    harness.llm.script = script
    async with harness.session() as s:
        await s.send(say("Delete everything."))
        await s.wait_for("bot-stopped-speaking")
        # Pipecat answered the model itself.
        tool_messages = harness.llm.tool_messages()
        assert len(tool_messages) == 1 and tool_messages[0]["tool_call_id"] == "call_evil"
        assert "rm -rf" not in tool_messages[0]["content"]
        assert "not currently available" in tool_messages[0]["content"]
        # The client never hears about a call to a tool it did not offer.
        assert s.of_type("llm-function-call-in-progress") == []
        assert s.of_type("llm-function-call-started") == []


async def test_long_running_tool_does_not_hold_the_conversation(harness):
    def script(body):
        text = str(body["messages"])
        if "It is 14:32." in text:
            return text_reply("It is half past two.")
        if "Are you still there" in text:
            return text_reply("Yes, I am still checking the clock.")
        return tool_reply("get_current_time", {})
    harness.llm.script = script
    async with harness.session(harness.config(long_running_tools=["get_current_time"])) as s:
        await s.send(say("What time is it?"))
        call = await s.wait_for("llm-function-call-in-progress")

        # The user talks while the tool runs. That is an interruption, and it
        # neither cancels the call nor waits for it.
        await s.send(say("Are you still there?"))
        await s.wait_for("bot-stopped-speaking")
        assert len(harness.llm.requests) == 2
        assert s.of_type("llm-function-call-stopped") == []
        # The model was offered a way to cancel the running call.
        offered = [t["function"]["name"] for t in harness.llm.requests[1]["tools"]]
        assert any(name.startswith("cancel_") for name in offered)

        # The late result is injected and answered.
        await s.send(tool_result(call, COMPLETED))
        stopped = await s.wait_for("llm-function-call-stopped")
        assert stopped["cancelled"] is False
        await s.wait_for("bot-stopped-speaking", count=2)
        assert "It is 14:32." in str(harness.llm.requests[-1]["messages"])
        # A late result travels in a message every chat template takes. A
        # "developer" message becomes a system message in Ollama and llama.cpp,
        # and Qwen's template refuses one that is not the first message.
        for request in harness.llm.requests:
            roles = [message["role"] for message in request["messages"]]
            assert "developer" not in roles
            assert "system" not in roles[1:]


async def test_disconnect_ends_the_session_and_forgets_pending_calls(harness):
    harness.llm.script = call_then_answer()
    async with harness.session() as s:
        await s.send(say("What time is it?"))
        await s.wait_for("llm-function-call-in-progress")
        relay = harness.voice._active.relay
        assert len(relay.pending_ids) == 1
    for _ in range(100):
        if harness.voice._active is None:
            break
        await asyncio.sleep(0.05)
    assert harness.voice._active is None
    assert relay.pending_ids == []
    assert len(harness.llm.requests) == 1


async def test_a_new_session_replaces_the_old_one(harness):
    async with harness.session() as first:
        async with harness.session() as second:
            await second.send(say("Hello"))
            await second.wait_for("bot-stopped-speaking")
            for _ in range(100):
                if first.ws.state.name == "CLOSED":
                    break
                await asyncio.sleep(0.05)
            assert first.ws.state.name == "CLOSED"


async def test_llm_failure_is_reported_to_the_client_and_the_session_survives(harness):
    harness.llm.status = 500
    async with harness.session() as s:
        await s.send(say("Hello"))
        await s.wait_for("error")
        harness.llm.status = 200
        await s.send(say("Hello again"))
        await s.wait_for("bot-stopped-speaking")
        assert s.audio_frames > 0


# ---- long running tools: interim reports, the filler, the end of a session ----


class _LongParams(_Params):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.properties = []
        self.spoken = []
        self.llm = self

    async def result_callback(self, result, *, properties=None):
        self.results.append(result)
        self.properties.append(properties)

    async def push_frame(self, frame):
        self.spoken.append(frame.text)


async def test_progress_goes_into_the_context_without_ending_a_long_call():
    relay, params = ToolRelay(frozenset({"computer_task"})), _LongParams(function_name="computer_task")
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0)
    assert relay.resolve("call_1", "computer_task", {"status": "progress", "text": "Step 1: Click at 5, 6"}) is True
    assert relay.resolve("call_1", "computer_task", {"status": "progress", "text": "Step 2: Type 4 characters"}) is True
    await asyncio.sleep(0.05)
    assert not task.done()
    assert params.results == ["Still running. Step 1: Click at 5, 6", "Still running. Step 2: Type 4 characters"]
    # Not final, and no spoken answer for each step.
    assert all(p.is_final is False and p.run_llm is False for p in params.properties)

    assert relay.resolve("call_1", "computer_task", {"status": "completed", "text": "The screen task is finished."}) is True
    await task
    assert params.results[-1] == "The screen task is finished."
    assert params.properties[-1] is None
    assert relay.resolve("call_1", "computer_task", {"status": "progress", "text": "late"}) is False


async def test_progress_for_a_tool_that_holds_the_answer_is_dropped():
    relay, params = ToolRelay(), _LongParams()
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0)
    relay.resolve("call_1", "get_current_time", {"status": "progress", "text": "half way"})
    await asyncio.sleep(0.05)
    assert params.results == [] and not task.done()
    relay.resolve("call_1", "get_current_time", COMPLETED)
    await task
    assert params.results == ["It is 14:32."]


async def test_a_slow_tool_gets_one_filler_sentence_and_a_fast_one_none():
    relay = ToolRelay(filler_after_secs=0.05)
    slow = _LongParams()
    task = asyncio.create_task(relay.handle(slow))
    await asyncio.sleep(0.15)
    assert slow.spoken == [tools.FILLER]
    relay.resolve("call_1", "get_current_time", COMPLETED)
    await task

    # Right after it: no second "One moment" within the same stretch.
    again = _LongParams(tool_call_id="call_2")
    task = asyncio.create_task(relay.handle(again))
    await asyncio.sleep(0.15)
    assert again.spoken == []
    relay.resolve("call_2", "get_current_time", COMPLETED)
    await task

    fast = _LongParams(tool_call_id="call_3")
    relay = ToolRelay(filler_after_secs=0.2)
    task = asyncio.create_task(relay.handle(fast))
    await asyncio.sleep(0)
    relay.resolve("call_3", "get_current_time", COMPLETED)
    await task
    await asyncio.sleep(0.3)
    assert fast.spoken == []


async def test_a_long_running_tool_gets_no_filler():
    relay, params = ToolRelay(frozenset({"computer_task"}), filler_after_secs=0.02), _LongParams(function_name="computer_task")
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0.1)
    assert params.spoken == []
    relay.resolve("call_1", "computer_task", COMPLETED)
    await task


async def test_the_end_of_a_session_wakes_every_parked_call_as_cancelled():
    relay, params = ToolRelay(), _LongParams()
    task = asyncio.create_task(relay.handle(params))
    await asyncio.sleep(0)
    relay.cancel_all()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert params.results == [] and relay.pending_ids == []


# ── The announcement and its tool call are one assistant message ───────────


def test_an_announcement_is_folded_into_the_call_it_announced():
    from lu_voice_loop.pipeline import fold_announcements

    call = {"id": "c1", "type": "function", "function": {"name": "file_write", "arguments": "{}"}}
    messages = [
        {"role": "user", "content": "Write milk into shopping.txt"},
        {"role": "assistant", "content": "I'll write milk into shopping.txt."},
        {"role": "assistant", "tool_calls": [call]},
        {"role": "tool", "content": '"File saved"', "tool_call_id": "c1"},
        {"role": "assistant", "content": "Done."},
        {"role": "user", "content": "Read it back"},
    ]
    folded = fold_announcements(messages)
    assert [m["role"] for m in folded] == ["user", "assistant", "tool", "assistant", "user"]
    assert folded[1] == {"role": "assistant", "content": "I'll write milk into shopping.txt.", "tool_calls": [call]}
    # The list the context holds is not edited in place, and a second pass has nothing to do.
    assert len(messages) == 6
    assert fold_announcements(folded) is None


def test_nothing_else_is_folded():
    from lu_voice_loop.pipeline import fold_announcements

    call = {"id": "c1", "type": "function", "function": {"name": "file_read", "arguments": "{}"}}
    # An answer after a result, a call that carries its own text, a call after a user turn.
    assert fold_announcements([
        {"role": "user", "content": "a"},
        {"role": "assistant", "tool_calls": [call]},
        {"role": "tool", "content": "x", "tool_call_id": "c1"},
        {"role": "assistant", "content": "The file says x."},
        {"role": "assistant", "content": "Anything else?"},
    ]) is None
    assert fold_announcements([
        {"role": "assistant", "content": "One."},
        {"role": "assistant", "content": "Reading.", "tool_calls": [call]},
    ]) is None
    assert fold_announcements([]) is None


async def test_the_second_request_of_a_session_shows_the_model_one_message_for_sentence_and_call(harness):
    def script(body):
        if any(m.get("role") == "tool" for m in body["messages"]):
            return text_reply("It is noon.")
        call = {"index": 0, "id": "call_abc123", "type": "function", "function": {"name": "get_current_time", "arguments": "{}"}}
        # One answer of the model: a sentence, then the call.
        return [
            _chunk({"role": "assistant", "content": "I'll look at the clock. "}),
            _chunk({"tool_calls": [call]}),
            _chunk({}, "tool_calls"),
            "data: [DONE]\n\n",
        ]

    harness.llm.script = script
    async with harness.session(harness.config(tools=[CLOCK_TOOL])) as s:
        await s.send(say("What time is it?"))
        call = await s.wait_for("llm-function-call-in-progress")
        await s.send(tool_result(call, COMPLETED))
        await s.wait_for("bot-stopped-speaking", count=2)

    second = harness.llm.requests[-1]["messages"]
    assistants = [m for m in second if m["role"] == "assistant"]
    assert assistants and assistants[0].get("tool_calls"), second
    assert "look at the clock" in (assistants[0].get("content") or ""), second
    # No assistant turn that announces and calls nothing is left for the model to copy.
    assert not any(m["role"] == "assistant" and not m.get("tool_calls") and "look at the clock" in (m.get("content") or "") for m in second)
