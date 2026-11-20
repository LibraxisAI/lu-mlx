"""Nothing a user said, typed or was sent may end up in the log."""

import asyncio
import io
import logging

import pytest
from conftest import TOKEN, quiet_test_logging
from lu_voice_loop.log import redact_record, setup_logging
from test_tools import COMPLETED, call_then_answer, say
from wire import message_frame, tool_result


def test_third_party_records_lose_their_text():
    text = redact_record("pipecat.services.openai.base_llm", "get_chat_completions", 336, "Generating chat from context [secret]", None)
    assert text == "pipecat.services.openai.base_llm:get_chat_completions:336"
    with_error = redact_record("uvicorn.error", "run_asgi", 413, "token=abc", "ImportError")
    assert with_error == "uvicorn.error:run_asgi:413 (ImportError)"


def test_own_records_keep_their_text():
    assert redact_record("lu_voice_loop.server", "f", 1, "Session started (2 tools offered).", None) == "Session started (2 tools offered)."
    # A look-alike package name does not count as ours.
    assert "secret" not in redact_record("lu_voice_loop_evil", "f", 1, "secret", None)


@pytest.fixture
def log_text(monkeypatch):
    """The redacted log of this test, as the sidecar would write it to stderr."""
    monkeypatch.delenv("LU_VOICE_LOG_CONTENT", raising=False)
    stream = io.StringIO()
    setup_logging(stream)
    yield stream.getvalue
    quiet_test_logging()
    logging.getLogger().handlers[:] = []


async def test_a_whole_session_leaves_no_content_in_the_log(harness, log_text):
    harness.llm.script = call_then_answer("SPOKEN ANSWER TEXT")
    config = harness.config(system_prompt="PRIVATE SYSTEM PROMPT")
    config["llm"]["api_key"] = "BEARER-FOR-THE-BRAIN"
    start = await harness.start(config)
    ticket = start["token"]

    async with harness.session(config) as s:
        await s.send(say("PRIVATE USER WORDS"))
        call = await s.wait_for("llm-function-call-in-progress")
        await s.send(tool_result(call, COMPLETED | {"text": "PRIVATE TOOL OUTPUT"}))
        await s.wait_for("bot-stopped-speaking")
        # A message that is not RTVI makes Pipecat log a warning that quotes it.
        await s.send(message_frame({"label": "something-else", "note": "PRIVATE STRAY MESSAGE"}))
        await asyncio.sleep(0.2)

    # A stdlib logger with a secret in the message, as uvicorn's access log would.
    logging.getLogger("uvicorn.error").warning("GET /ws?token=%s", ticket)

    log = log_text()
    assert "Session started" in log
    # The stray message was noticed, and reported by location only.
    assert "pipecat.processors.frameworks.rtvi.processor:_handle_transport_message" in log
    assert "uvicorn.error:" in log
    for secret in (
        "PRIVATE", "SPOKEN ANSWER", "BEARER-FOR-THE-BRAIN", TOKEN, ticket,
        "get_current_time", "zone", "call_abc123",
    ):
        assert secret not in log, secret
