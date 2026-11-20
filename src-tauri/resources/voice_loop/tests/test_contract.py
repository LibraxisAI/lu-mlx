"""The wire contract with the app's VoiceToolBridge, from the sidecar's side.

fixtures/rtvi_tool_messages.json is shared with the desktop test
src/api/__tests__/voice-tool-bridge.test.ts. If either side changes shape,
one of the two suites fails.
"""

import json
from pathlib import Path

from conftest import text_reply, tool_reply
from test_tools import say
from wire import message_frame

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "rtvi_tool_messages.json").read_text())


def _script(body):
    if any(m.get("role") == "tool" for m in body["messages"]):
        return text_reply("Fetched.")
    call = FIXTURE["in_progress"]["data"]
    return tool_reply(call["function_name"], call["arguments"], call_id=call["tool_call_id"])


def _wire(session, type_: str) -> dict:
    message = next(m for m in session.messages if m.get("type") == type_)
    return {k: v for k, v in message.items() if k != "id"}


async def test_sidecar_emits_and_accepts_the_shared_messages(harness):
    harness.llm.script = _script
    async with harness.session(harness.config(tools=[FIXTURE["tool"]])) as s:
        await s.send(say("Fetch it."))
        await s.wait_for("llm-function-call-in-progress")
        assert _wire(s, "llm-function-call-in-progress") == FIXTURE["in_progress"]

        # The bridge's answer, byte for byte as the app sends it.
        await s.send(message_frame(FIXTURE["result"] | {"id": "bridge-1"}))
        await s.wait_for("llm-function-call-stopped")
        assert _wire(s, "llm-function-call-stopped") == FIXTURE["stopped_completed"]
        await s.wait_for("bot-stopped-speaking")

    tool_messages = harness.llm.tool_messages()
    assert len(tool_messages) == 1 and "done" in tool_messages[0]["content"]
    assert s.of_type("error") == [] and s.of_type("error-response") == []


async def test_sidecar_reports_a_cancelled_call_in_the_shared_shape(harness):
    harness.llm.script = _script
    async with harness.session(harness.config(tools=[FIXTURE["tool"]])) as s:
        await s.send(say("Fetch it."))
        await s.wait_for("llm-function-call-in-progress")
        harness.llm.script = lambda body: text_reply("Stopped.")
        await s.send(say("Stop."))
        await s.wait_for("llm-function-call-stopped")
        assert _wire(s, "llm-function-call-stopped") == FIXTURE["stopped_cancelled"]
