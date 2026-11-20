"""A session on a model that Ollama serves names the chat's context window.

Ollama loads a model again for every request that names another window than
the one it is loaded with, and its OpenAI compatible endpoint cannot name one.
With `llm.ollama_num_ctx` the session talks to /api/chat. These tests hold
the translation to what Ollama's own compatibility layer does, and prove on
the real pipeline that every request of a session carries the window.
"""

import json

import httpx2
import pytest

from conftest import native_text_reply, native_tool_reply
from lu_voice_loop.ollama_native import OllamaNativeTransport, StreamTranslation, to_native_request, to_openai_completion
from test_session_control import wait_for_server_message
from test_thinking import spoken
from test_tools import say
from wire import message_frame, rtvi

WINDOW = 16384


def native_config(harness, **llm):
    return harness.config(llm={"base_url": harness.llm_url, "model": "fake", "ollama_num_ctx": WINDOW, **llm})


# ── The request ──────────────────────────────────────────────────────────


def test_the_request_carries_the_window_and_the_defaults_of_the_compatible_endpoint():
    native = to_native_request({"model": "m", "stream": True, "messages": [{"role": "user", "content": "Hi"}]}, WINDOW)
    assert native == {
        "model": "m",
        "stream": True,
        "messages": [{"role": "user", "content": "Hi"}],
        # Ollama's compatible endpoint sets temperature and top_p to 1.0 for
        # a request without them; the same request sounds the same here.
        "options": {"temperature": 1.0, "top_p": 1.0, "num_ctx": WINDOW},
    }


def test_sampling_fields_and_the_output_limit_become_options():
    native = to_native_request({
        "model": "m", "messages": [], "temperature": 0.4, "top_p": 0.9, "max_tokens": 1, "seed": 7,
        "frequency_penalty": 0.1, "presence_penalty": 0.2, "stop": "END",
        # Fields the compatible endpoint does not read are not sent on, and
        # the older name of the output limit wins over the newer one.
        "max_completion_tokens": 99, "tool_choice": "auto", "stream_options": {"include_usage": True},
    }, WINDOW)
    assert native["options"] == {
        "stop": ["END"], "num_predict": 1, "temperature": 0.4, "top_p": 0.9, "seed": 7,
        "frequency_penalty": 0.1, "presence_penalty": 0.2, "num_ctx": WINDOW,
    }
    assert native["stream"] is False
    assert set(native) == {"model", "messages", "options", "stream"}


def test_the_newer_name_of_the_output_limit_counts_when_the_older_one_is_missing():
    # The prewarm asks for one token under this name.
    native = to_native_request({"model": "m", "messages": [], "max_completion_tokens": 1}, WINDOW)
    assert native["options"]["num_predict"] == 1


@pytest.mark.parametrize("body, think", [
    ({"reasoning_effort": "none"}, False),
    ({"reasoning_effort": "low"}, "low"),
    ({"reasoning_effort": "minimal"}, "low"),
    ({"reasoning_effort": "xhigh"}, "max"),
    ({"reasoning": {"effort": "high"}}, "high"),
])
def test_the_thinking_switch_becomes_think(body, think):
    assert to_native_request({"model": "m", "messages": [], **body}, WINDOW)["think"] == think


def test_a_request_without_a_thinking_field_sends_no_think():
    assert "think" not in to_native_request({"model": "m", "messages": []}, WINDOW)


def test_a_tool_turn_is_carried_over_with_its_call_and_its_result():
    call = {"id": "call_1", "type": "function", "function": {"name": "get_current_time", "arguments": '{"zone": "local"}'}}
    tools = [{"type": "function", "function": {"name": "get_current_time", "parameters": {"type": "object"}}}]
    native = to_native_request({
        "model": "m", "tools": tools,
        "messages": [
            {"role": "user", "content": "What time is it?"},
            {"role": "assistant", "content": None, "tool_calls": [call]},
            {"role": "tool", "tool_call_id": "call_1", "content": "14:30"},
        ],
    }, WINDOW)
    assert native["tools"] == tools
    assert native["messages"][1] == {
        "role": "assistant", "content": "",
        "tool_calls": [{"id": "call_1", "function": {"name": "get_current_time", "arguments": {"zone": "local"}}}],
    }
    # The result names the tool it answers; the name is looked up by the id.
    assert native["messages"][2] == {"role": "tool", "content": "14:30", "tool_name": "get_current_time", "tool_call_id": "call_1"}


def test_a_picture_travels_as_bare_base64():
    native = to_native_request({"model": "m", "messages": [{"role": "user", "content": [
        {"type": "text", "text": "What is this?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGk="}},
    ]}]}, WINDOW)
    assert native["messages"] == [
        {"role": "user", "content": "What is this?"},
        {"role": "user", "content": "", "images": ["aGk="]},
    ]


# ── The answer ───────────────────────────────────────────────────────────


def test_a_streamed_answer_becomes_chunks_with_a_finish_and_the_counts():
    stream = StreamTranslation("chatcmpl-1", include_usage=True)
    first, last = native_text_reply("Hello there.")
    chunks = stream.feed(first) + stream.feed(last)
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant", "content": "Hello there."}
    assert [c["choices"][0]["finish_reason"] for c in chunks[:3]] == [None, None, "stop"]
    assert chunks[2]["choices"][0]["delta"] == {}
    assert chunks[3]["choices"] == [] and chunks[3]["usage"] == {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}


def test_a_thought_and_an_answer_in_one_line_are_two_chunks():
    stream = StreamTranslation("chatcmpl-1", include_usage=False)
    line = {"model": "fake", "message": {"role": "assistant", "content": "Yes.", "thinking": "Hm."}, "done": False}
    thought, answer = stream.feed(line)
    assert thought["choices"][0]["delta"] == {"role": "assistant", "reasoning": "Hm."}
    assert answer["choices"][0]["delta"] == {"content": "Yes."}


def test_a_tool_call_ends_the_stream_as_tool_calls():
    stream = StreamTranslation("chatcmpl-1", include_usage=False)
    first, last = native_tool_reply("get_current_time", {"zone": "local"})
    chunks = stream.feed(first) + stream.feed(last)
    assert chunks[0]["choices"][0]["delta"]["tool_calls"] == [
        {"id": "call_abc123", "index": 0, "type": "function", "function": {"name": "get_current_time", "arguments": '{"zone": "local"}'}},
    ]
    assert chunks[-1]["choices"][0]["finish_reason"] == "tool_calls"


def test_a_tool_call_without_an_id_gets_one():
    stream = StreamTranslation("chatcmpl-1", include_usage=False)
    line = {"model": "fake", "message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "t", "arguments": {}}}]}, "done": False}
    call = stream.feed(line)[0]["choices"][0]["delta"]["tool_calls"][0]
    assert call["id"].startswith("call_") and len(call["id"]) > 5


def test_a_one_shot_answer_becomes_a_chat_completion():
    done = to_openai_completion("chatcmpl-1", {"model": "fake", "message": {"role": "assistant", "content": "Summary.", "thinking": "Hm."}, "done": True, "done_reason": "stop", "prompt_eval_count": 4, "eval_count": 2})
    assert done["choices"] == [{"index": 0, "message": {"role": "assistant", "content": "Summary.", "reasoning": "Hm."}, "finish_reason": "stop"}]
    assert done["usage"]["total_tokens"] == 6


# ── The road ─────────────────────────────────────────────────────────────


async def test_only_chat_completions_are_carried_to_the_native_api():
    seen = []

    def upstream(request: httpx2.Request) -> httpx2.Response:
        seen.append((request.method, request.url.path, request.headers.get("authorization")))
        if request.url.path == "/api/chat":
            return httpx2.Response(200, json=native_text_reply("Hi.")[-1] | {"message": {"role": "assistant", "content": "Hi."}})
        return httpx2.Response(200, json={"data": []})

    transport = OllamaNativeTransport(WINDOW, inner=httpx2.MockTransport(upstream))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1", headers={"Authorization": "Bearer k"}) as client:
        await client.get("/models")
        answer = await client.post("/chat/completions", json={"model": "m", "messages": [{"role": "user", "content": "Hi"}]})
    assert seen == [("GET", "/v1/models", "Bearer k"), ("POST", "/api/chat", "Bearer k")]
    assert answer.json()["choices"][0]["message"]["content"] == "Hi."


async def test_a_refusal_keeps_its_status_and_its_sentence():
    transport = OllamaNativeTransport(WINDOW, inner=httpx2.MockTransport(lambda request: httpx2.Response(400, json={"error": '"fake" does not support thinking'})))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        answer = await client.post("/chat/completions", json={"model": "fake", "messages": [], "reasoning_effort": "low"})
    assert answer.status_code == 400
    assert answer.json()["error"]["message"] == '"fake" does not support thinking'
    assert answer.json()["error"]["type"] == "invalid_request_error"


# ── The way back for a server without the native API ─────────────────────


def _server(chat_status, version_status, seen, chat_error=None):
    """A stand-in server: what /api/chat and /api/version answer, and a compatible endpoint that works."""

    def upstream(request: httpx2.Request) -> httpx2.Response:
        seen.append((request.method, request.url.path))
        if request.url.path == "/api/chat":
            if chat_error is not None:
                raise chat_error
            if chat_status == 200:
                return httpx2.Response(200, json={"model": "m", "message": {"role": "assistant", "content": "Native."}, "done": True, "done_reason": "stop"})
            return httpx2.Response(chat_status, json={"error": "model 'm' not found"} if version_status == 200 else None, text=None if version_status == 200 else "404 page not found")
        if request.url.path == "/api/version":
            return httpx2.Response(200, json={"version": "0.1.2"}) if version_status == 200 else httpx2.Response(version_status, text="404 page not found")
        body = json.loads(request.content)
        assert "options" not in body
        return httpx2.Response(200, json={"id": "c", "object": "chat.completion", "created": 0, "model": "m", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Compatible."}}]})

    return httpx2.MockTransport(upstream)


ASK = {"model": "m", "messages": [{"role": "user", "content": "Hi"}], "temperature": 0.3}


@pytest.mark.parametrize("status", [404, 405])
async def test_a_server_without_the_native_api_is_asked_on_the_compatible_endpoint_for_the_rest_of_the_session(status):
    seen = []
    transport = OllamaNativeTransport(WINDOW, inner=_server(status, 404, seen))
    async with httpx2.AsyncClient(transport=transport, base_url="http://proxy.test/v1") as client:
        first = await client.post("/chat/completions", json=ASK)
        second = await client.post("/chat/completions", json=ASK)
    assert first.json()["choices"][0]["message"]["content"] == "Compatible."
    assert second.json()["choices"][0]["message"]["content"] == "Compatible."
    # Found out once: the native road is not tried again in this session.
    assert seen == [("POST", "/api/chat"), ("GET", "/api/version"), ("POST", "/v1/chat/completions"), ("POST", "/v1/chat/completions")]


async def test_the_way_back_is_written_to_the_log_once():
    from loguru import logger
    lines = []
    sink = logger.add(lambda message: lines.append(str(message)), level="WARNING")
    try:
        transport = OllamaNativeTransport(WINDOW, inner=_server(404, 404, []))
        async with httpx2.AsyncClient(transport=transport, base_url="http://proxy.test/v1") as client:
            await client.post("/chat/completions", json=ASK)
            await client.post("/chat/completions", json=ASK)
    finally:
        logger.remove(sink)
    said = [line for line in lines if "OpenAI compatible endpoint" in line]
    assert len(said) == 1
    assert "/api/chat with HTTP 404" in said[0] and "names no context window" in said[0]


async def test_a_model_that_is_not_there_is_no_reason_to_change_the_road():
    # Ollama answers a missing model with 404 as well. /api/version answers,
    # so the native API is there and the failure is the model's.
    seen = []
    transport = OllamaNativeTransport(WINDOW, inner=_server(404, 200, seen))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        first = await client.post("/chat/completions", json=ASK)
        second = await client.post("/chat/completions", json=ASK)
    assert first.status_code == 404 and second.status_code == 404
    assert first.json()["error"]["message"] == "model 'm' not found"
    # Asked once whether the native API is there, and never the other road.
    assert seen == [("POST", "/api/chat"), ("GET", "/api/version"), ("POST", "/api/chat")]


@pytest.mark.parametrize("status", [400, 401, 403, 500, 502, 503])
async def test_no_other_refusal_changes_the_road(status):
    seen = []
    transport = OllamaNativeTransport(WINDOW, inner=_server(status, 404, seen))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        answer = await client.post("/chat/completions", json=ASK)
    assert answer.status_code == status
    assert seen == [("POST", "/api/chat")]


@pytest.mark.parametrize("error", [
    httpx2.ReadTimeout("the limit"), httpx2.ConnectTimeout("the limit"), httpx2.ConnectError("refused"), httpx2.ReadError("cut"),
])
async def test_a_limit_or_a_broken_connection_is_passed_on_and_changes_nothing(error):
    seen = []
    transport = OllamaNativeTransport(WINDOW, inner=_server(200, 404, seen, chat_error=error))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        with pytest.raises(type(error)):
            await client.post("/chat/completions", json=ASK)
        with pytest.raises(type(error)):
            await client.post("/chat/completions", json=ASK)
    assert seen == [("POST", "/api/chat"), ("POST", "/api/chat")]


async def test_a_cancelled_request_is_cancelled_and_changes_nothing():
    import asyncio
    seen = []
    transport = OllamaNativeTransport(WINDOW, inner=_server(200, 404, seen, chat_error=asyncio.CancelledError()))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        with pytest.raises(asyncio.CancelledError):
            await client.post("/chat/completions", json=ASK)
    assert seen == [("POST", "/api/chat")]


async def test_a_server_that_does_not_answer_the_second_look_is_not_taken_for_one_without_the_native_api():
    # 404 on /api/chat, and then the server is gone: nothing is known about
    # it, so nothing is decided and the failure is the one that is passed on.
    seen = []

    def upstream(request: httpx2.Request) -> httpx2.Response:
        seen.append((request.method, request.url.path))
        if request.url.path == "/api/version":
            raise httpx2.ConnectError("refused")
        return httpx2.Response(404, text="404 page not found")

    transport = OllamaNativeTransport(WINDOW, inner=httpx2.MockTransport(upstream))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        with pytest.raises(httpx2.ConnectError):
            await client.post("/chat/completions", json=ASK)
    assert ("POST", "/v1/chat/completions") not in seen


async def test_after_the_native_api_answered_once_a_404_never_changes_the_road():
    answers = iter([200, 404, 404])
    seen = []

    def upstream(request: httpx2.Request) -> httpx2.Response:
        seen.append((request.method, request.url.path))
        if next(answers) == 200:
            return httpx2.Response(200, json={"model": "m", "message": {"role": "assistant", "content": "Native."}, "done": True, "done_reason": "stop"})
        return httpx2.Response(404, text="404 page not found")

    transport = OllamaNativeTransport(WINDOW, inner=httpx2.MockTransport(upstream))
    async with httpx2.AsyncClient(transport=transport, base_url="http://ollama.test:11434/v1") as client:
        assert (await client.post("/chat/completions", json=ASK)).status_code == 200
        assert (await client.post("/chat/completions", json=ASK)).status_code == 404
        assert (await client.post("/chat/completions", json=ASK)).status_code == 404
    assert seen == [("POST", "/api/chat")] * 3


async def test_a_whole_session_on_a_server_without_the_native_api_is_heard_on_the_compatible_endpoint(harness):
    harness.llm.native_api = False
    async with harness.session(native_config(harness) | {"prewarm": True}) as s:
        await wait_for_server_message(s, "warm")
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        assert spoken(s).strip() == "Hello there."
        assert s.of_type("error") == []
    # One try on the native road, one look at /api/version, then the old road
    # for the prewarm and the turn, and no window in any of them.
    assert len(harness.llm.native_requests) == 1
    assert harness.llm.version_requests == 1
    assert len(harness.llm.requests) >= 2
    assert all("options" not in body and "num_ctx" not in body for body in harness.llm.requests)


async def test_a_refused_model_in_a_whole_session_stays_on_the_native_road(harness):
    harness.llm.native_status = 404
    harness.llm.native_refusal = '{"error": "model \'fake\' not found"}'
    async with harness.session(native_config(harness)) as s:
        await s.send(say("Hello"))
        await s.wait_for("error")
    assert harness.llm.requests == []
    assert harness.llm.version_requests == 1


# ── A whole session ──────────────────────────────────────────────────────


async def test_every_request_of_a_session_names_the_window_and_none_takes_the_other_road(harness):
    harness.llm.native_script = lambda body: (
        native_text_reply("It is half past two.") if any(m.get("role") == "tool" for m in body["messages"])
        else native_tool_reply("get_current_time", {"zone": "local"}) if body.get("tools") and body.get("stream")
        else native_text_reply("Hello there.")
    )
    async with harness.session(native_config(harness) | {"prewarm": True}) as s:
        # The prewarm is a request like any other: it loads the model, so it
        # is the one that must name the window first.
        await wait_for_server_message(s, "warm")
        await s.send(say("What time is it?"))
        call = await s.wait_for("llm-function-call-in-progress")
        await s.send(message_frame(rtvi("llm-function-call-result", {
            "function_name": call["function_name"], "tool_call_id": call["tool_call_id"], "arguments": call["arguments"], "result": "14:30",
        })))
        await s.wait_for("bot-stopped-speaking")
        assert spoken(s).strip() == "It is half past two."
        assert s.of_type("error") == []

    assert harness.llm.requests == []
    assert len(harness.llm.native_requests) >= 3
    assert {body["options"]["num_ctx"] for body in harness.llm.native_requests} == {WINDOW}
    # The prewarm does not stream and asks for one token.
    warm = harness.llm.native_requests[0]
    assert warm["stream"] is False and warm["options"]["num_predict"] == 1
    # The tool result went back with the name of its tool.
    result = [m for m in harness.llm.native_requests[-1]["messages"] if m.get("role") == "tool"]
    assert result and result[0]["tool_name"] == "get_current_time"


async def test_a_session_without_the_window_stays_on_the_compatible_endpoint(harness):
    async with harness.session() as s:
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
    assert harness.llm.native_requests == []
    assert len(harness.llm.requests) == 1


async def test_a_refused_thinking_field_is_asked_again_on_the_native_road(harness):
    harness.llm.native_status = lambda body: 400 if body.get("think") == "low" else 200
    harness.llm.native_refusal = json.dumps({"error": '"fake" does not support thinking'})
    config = native_config(harness, extra={"reasoning_effort": "low"}) | {"thinking": {"direct_extra": {"reasoning_effort": "none"}}}
    async with harness.session(config) as s:
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        assert spoken(s).strip() == "Hello there."
    first, second = harness.llm.native_requests
    assert first["think"] == "low" and second["think"] is False
    assert first["options"]["num_ctx"] == second["options"]["num_ctx"] == WINDOW


async def test_a_thought_on_the_native_road_is_not_spoken(harness):
    harness.llm.native_script = lambda body: [
        {"model": "fake", "message": {"role": "assistant", "content": "", "thinking": "Let me think."}, "done": False},
        *native_text_reply("Hello there."),
    ]
    config = native_config(harness) | {"thinking": {"wanted": True}}
    async with harness.session(config) as s:
        await s.send(say("Hello"))
        await s.wait_for("bot-stopped-speaking")
        assert spoken(s).strip() == "Hello there."
        thoughts = [m for m in s.of_type("server-message") if m.get("type") == "thought" and m.get("phase") == "text"]
        assert "".join(t["text"] for t in thoughts) == "Let me think."
