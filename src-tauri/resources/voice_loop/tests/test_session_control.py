"""What the app can ask of a running session: prewarm, a spoken sentence,
a new key for the model, and a context that does not grow without end."""

import asyncio

from conftest import text_reply
from lu_voice_loop.pipeline import HOLD_SENTENCE, MAX_SAY_CHARS, summarization_params
from lu_voice_loop.config import SessionConfig
from wire import client_message, message_frame, rtvi


def say(text: str) -> bytes:
    return message_frame(rtvi("send-text", {"content": text, "options": {"run_immediately": True, "audio_response": True}}))


def server_messages(session, kind: str) -> list[dict]:
    return [m for m in session.of_type("server-message") if m.get("type") == kind]


async def wait_for_server_message(session, kind: str, timeout: float = 10.0) -> dict:
    async def poll():
        while not server_messages(session, kind):
            await asyncio.sleep(0.01)
        return server_messages(session, kind)[0]
    return await asyncio.wait_for(poll(), timeout)


async def test_prewarm_sends_the_same_start_as_the_first_real_turn(harness):
    async with harness.session(harness.config(prewarm=True)) as s:
        warm = await wait_for_server_message(s, "warm")
        assert warm["ok"] is True and warm["secs"] >= 0
        await s.send(say("What time is it?"))
        await s.wait_for("bot-stopped-speaking")

    first, turn = harness.llm.requests[0], harness.llm.requests[1]
    # One token, no stream: the answer is thrown away.
    assert first["stream"] is False
    assert first.get("max_tokens") == 1 or first.get("max_completion_tokens") == 1
    # What a local server caches is the start of the prompt: the system
    # message and the tools. They are the same in both requests.
    assert first["messages"][0] == turn["messages"][0] == {"role": "system", "content": "You are a test assistant."}
    assert first["tools"] == turn["tools"]
    assert first["model"] == turn["model"]
    assert first["messages"][1] == {"role": "user", "content": "Hi"}
    # The throwaway greeting is not part of the conversation.
    assert all(m.get("content") != "Hi" for m in turn["messages"])


async def test_no_prewarm_unless_the_app_asks_for_it(harness):
    async with harness.session() as s:
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        assert server_messages(s, "warm") == []
    assert all(body["stream"] is True for body in harness.llm.requests)


async def test_a_failed_prewarm_is_reported_and_the_session_goes_on(harness):
    harness.llm.status = 500
    async with harness.session(harness.config(prewarm=True)) as s:
        warm = await wait_for_server_message(s, "warm")
        assert warm["ok"] is False
        harness.llm.status = 200
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        assert s.audio_frames > 0


async def test_a_question_of_computer_control_is_spoken_and_stays_out_of_the_context(harness):
    # In the context it is an assistant message of its own, and the model
    # says it again as its answer to the result of the task.
    async with harness.session() as s:
        await s.send(client_message("question", {"id": "q-1", "text": "May I work in Editor? Say yes or no.", "voice": True}))
        await s.wait_for("bot-stopped-speaking")
        spoken = " ".join(m.get("text", "") for m in s.of_type("bot-tts-text"))
        assert "May I work in Editor?" in spoken
        assert harness.llm.requests == []
        await s.send(client_message("question-closed", {"id": "q-1"}))
        await s.send(say("What happened?"))
        await s.wait_for("bot-stopped-speaking", count=2)
    assert all("May I work in Editor?" not in str(m.get("content")) for m in harness.llm.requests[0]["messages"])


async def test_on_hold_the_model_is_not_asked_and_answers_everything_afterwards(harness):
    # One graphics card, one model in the engine: while the screen model is
    # loaded, a request for the chat model fails or reaches the wrong model.
    async with harness.session() as s:
        await s.send(client_message("hold", {"on": True}))
        await s.send(say("Are you still there?"))
        await s.wait_for("bot-stopped-speaking")
        spoken = " ".join(m.get("text", "") for m in s.of_type("bot-tts-text"))
        assert HOLD_SENTENCE in spoken
        assert harness.llm.requests == []
        # Said once, not after every sentence.
        await s.send(say("Hello?"))
        await asyncio.sleep(0.5)
        assert harness.llm.requests == []
        assert " ".join(m.get("text", "") for m in s.of_type("bot-tts-text")).count(HOLD_SENTENCE) == 1

        await s.send(client_message("hold", {"on": False}))
        await s.send(say("And now?"))
        await s.wait_for("bot-stopped-speaking", count=2)
    # The model reads what was said in the meantime with its next request.
    said = [str(m.get("content")) for m in harness.llm.requests[0]["messages"] if m.get("role") == "user"]
    assert any("Are you still there?" in text for text in said)
    assert any("And now?" in text for text in said)


async def test_malformed_control_messages_change_nothing(harness):
    async with harness.session() as s:
        for kind, data in [
            ("question", {"text": "No id"}), ("question", {"id": "q", "text": 7}), ("question", {"id": "q", "text": "   "}),
            # "say" was a message of its own once. It is gone, and a client that still sends it is not spoken for.
            ("say", {"text": "Speak this."}),
            ("question", {"id": 5, "text": "x"}), ("llm-key", {"api_key": ""}), ("llm-key", {"api_key": 9}),
            ("task", "yes"), ("hold", "yes"), ("hold", {"on": "true"}), ("unknown-kind", {"a": 1}), ("question-closed", None),
        ]:
            await s.send(client_message(kind, data))
        await asyncio.sleep(0.3)
        assert s.audio_frames == 0
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
    assert harness.llm.headers[0]["authorization"] == "Bearer not-needed"


async def test_a_long_question_is_cut(harness):
    async with harness.session() as s:
        await s.send(client_message("question", {"id": "q-long", "text": "word " * 400, "voice": True}))
        await s.wait_for("bot-stopped-speaking")
        spoken = " ".join(m.get("text", "") for m in s.of_type("bot-tts-text"))
        assert 0 < len(spoken) <= MAX_SAY_CHARS + 10


async def test_a_new_key_is_used_from_the_next_turn_on(harness):
    config = harness.config()
    config["llm"]["api_key"] = "first-key"
    async with harness.session(config) as s:
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        await s.send(client_message("llm-key", {"api_key": "second-key"}))
        await asyncio.sleep(0.1)
        await s.send(say("Hello again"))
        await s.wait_for("bot-stopped-speaking", count=2)
    assert [h["authorization"] for h in harness.llm.headers] == ["Bearer first-key", "Bearer second-key"]


def test_summaries_are_off_without_a_limit_and_sized_by_it():
    base = {"llm": {"base_url": "http://127.0.0.1:1/v1", "model": "m"}}
    assert summarization_params(SessionConfig.model_validate(base)).enable_auto_context_summarization is False
    params = summarization_params(SessionConfig.model_validate({**base, "context_limit_tokens": 3000}))
    assert params.enable_auto_context_summarization is True
    auto = params.auto_context_summarization_config
    assert auto.max_context_tokens == 3000 and auto.max_unsummarized_messages is None
    assert auto.summary_config.target_context_tokens == 750
    assert auto.summary_config.min_messages_after_summary == 6


async def test_a_long_conversation_is_folded_into_a_summary(harness):
    harness.llm.script = lambda body: text_reply("This is a fairly long answer about the weather and the news of the day. " * 6)
    harness.llm.one_shot = lambda body: "They talked about the weather."
    async with harness.session(harness.config(context_limit_tokens=500)) as s:
        for turn in range(1, 9):
            await s.send(say("Question number %d, please tell me more about it in detail." % turn))
            await s.wait_for("bot-stopped-speaking", count=turn, timeout=20)
        await asyncio.sleep(0.5)

    summaries = [body for body in harness.llm.requests if body["stream"] is False]
    assert summaries, "the conversation was never summarized"
    turns = [body for body in harness.llm.requests if body["stream"] is True]
    last = turns[-1]["messages"]
    assert any("Summary of the conversation so far: They talked about the weather." in str(m.get("content")) for m in last)
    # The context stopped growing. Kept whole, eight such turns are 3500
    # characters and every further turn adds 490.
    sizes = [sum(len(str(m.get("content"))) for m in body["messages"]) for body in turns]
    assert max(sizes) < 3000, sizes
    # The system prompt is still the first message, untouched.
    assert last[0] == {"role": "system", "content": "You are a test assistant."}
