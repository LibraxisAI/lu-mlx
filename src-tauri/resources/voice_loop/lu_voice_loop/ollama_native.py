"""Ollama's own chat API behind the OpenAI client, so a request can name a context window.

Ollama keeps a model loaded for one context window (num_ctx) and loads it
again for a request that names another. Its OpenAI compatible endpoint cannot
name one at all: the request has no field for it, so every request there asks
for the server's default window. A model the chat loaded with 16384 was
therefore loaded again when a voice session started, and again when the chat
went on afterwards.

The app tells the voice loop the window the chat sends for this model
(`llm.ollama_num_ctx`). With it set, the requests of a session go to
`/api/chat`, which takes `options.num_ctx`, and the answer is handed back in
the shape the OpenAI client reads. Everything above this file (the pipeline,
the thinking rules, the tool relay) sees an OpenAI compatible server, exactly
as before.

The two translations follow what Ollama's own compatibility layer does with
a chat completions request, field for field (openai/openai.go in its source:
`FromChatRequest`, `ToStreamChunks`, `FinishChunk`, `ToChatCompletion`). Two
things are added: `options.num_ctx`, and `max_completion_tokens` counts as
the output limit when `max_tokens` is not set.

A server that speaks only the compatible endpoint (a proxy in front of the
model server that lets /v1 through and nothing else) answers /api/chat with
404 or 405. That is found out on the first request of a session, and the
session then stays on the compatible endpoint, without a window, as every
session did before this file existed. See `OllamaNativeTransport`.
"""

import base64
import binascii
import json
import secrets
import time
from typing import Any, AsyncIterator

# The OpenAI client is built on httpx2, so its transport has to be one too.
import httpx2 as httpx
from loguru import logger

CHAT_COMPLETIONS_SUFFIX = "/chat/completions"
NATIVE_CHAT_PATH = "/api/chat"
NATIVE_VERSION_PATH = "/api/version"
# What a server says about a path it does not have. A model that is not there
# is a 404 as well, which is why the answer alone decides nothing.
_NO_SUCH_PATH = (404, 405)

# Effort names the compatibility layer folds onto the ones a model knows.
_EFFORT_ALIASES = {"minimal": "low", "xhigh": "max", "ultra": "max"}
_IMAGE_PREFIXES = tuple("data:image/%s;base64," % kind for kind in ("jpeg", "jpg", "png", "webp")) + ("data:;base64,",)


class UnsupportedRequest(ValueError):
    """A request this translation cannot carry. Answered with HTTP 400, like the server would."""


def _image_bytes_b64(url: str) -> str:
    for prefix in _IMAGE_PREFIXES:
        if url.startswith(prefix):
            data = url[len(prefix):]
            try:
                base64.b64decode(data, validate=True)
            except (binascii.Error, ValueError):
                raise UnsupportedRequest("invalid image input")
            return data
    raise UnsupportedRequest("invalid image input")


def _tool_calls(calls: list[dict]) -> list[dict]:
    out = []
    for call in calls:
        function = call.get("function") or {}
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except ValueError:
            raise UnsupportedRequest("invalid tool call arguments")
        native: dict[str, Any] = {"function": {"name": function.get("name", ""), "arguments": arguments}}
        if call.get("id"):
            native["id"] = call["id"]
        out.append(native)
    return out


def _tool_name_for(messages: list[dict], call_id: str) -> str:
    for message in reversed(messages):
        for call in message.get("tool_calls") or []:
            if call.get("id") == call_id:
                return (call.get("function") or {}).get("name", "")
    return ""


def _native_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for message in messages:
        role = message.get("role", "")
        content = message.get("content")
        calls = message.get("tool_calls") or []
        call_id = message.get("tool_call_id") or ""
        tool_name = ""
        if role.lower() == "tool":
            tool_name = message.get("name") or (_tool_name_for(messages, call_id) if call_id else "")

        def labelled(native: dict) -> dict:
            if tool_name:
                native["tool_name"] = tool_name
            if call_id:
                native["tool_call_id"] = call_id
            return native

        if isinstance(content, str):
            native = {"role": role, "content": content}
            if message.get("reasoning"):
                native["thinking"] = message["reasoning"]
            if calls:
                native["tool_calls"] = _tool_calls(calls)
            out.append(labelled(native))
        elif isinstance(content, list):
            parts: list[dict] = []
            for part in content:
                if not isinstance(part, dict):
                    raise UnsupportedRequest("invalid message format")
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    parts.append({"role": role, "content": part["text"]})
                elif part.get("type") == "image_url":
                    image = part.get("image_url")
                    url = image.get("url") if isinstance(image, dict) else image
                    if not isinstance(url, str):
                        raise UnsupportedRequest("invalid message format")
                    parts.append({"role": role, "content": "", "images": [_image_bytes_b64(url)]})
                else:
                    raise UnsupportedRequest("invalid message format")
            if role.lower() == "tool":
                # One tool result. Text parts become one message; with a
                # picture among them every part keeps the call it answers.
                if any(part.get("images") for part in parts):
                    parts = [labelled(part) for part in parts]
                elif parts or tool_name or call_id:
                    parts = [labelled({"role": role, "content": "".join(part["content"] for part in parts)})]
            if parts and calls:
                parts[-1]["tool_calls"] = _tool_calls(calls)
                labelled(parts[-1])
                if message.get("reasoning"):
                    parts[-1]["thinking"] = message["reasoning"]
            out.extend(parts)
        else:
            # No content is only allowed next to tool calls.
            if not calls:
                raise UnsupportedRequest("invalid message content type")
            native = {"role": role, "content": "", "tool_calls": _tool_calls(calls)}
            if message.get("reasoning"):
                native["thinking"] = message["reasoning"]
            if call_id:
                native["tool_call_id"] = call_id
            out.append(native)
    return out


def _think(body: dict) -> Any:
    """The `think` field, or None to leave it out."""
    reasoning = body.get("reasoning")
    effort = reasoning.get("effort") if isinstance(reasoning, dict) else body.get("reasoning_effort")
    if not isinstance(effort, str) or effort == "":
        return None
    if effort == "none":
        return False
    return _EFFORT_ALIASES.get(effort, effort)


def to_native_request(body: dict, num_ctx: int) -> dict:
    """A chat completions request body as a request to /api/chat, with the window in it."""
    options: dict[str, Any] = {}
    stop = body.get("stop")
    if isinstance(stop, str):
        options["stop"] = [stop]
    elif isinstance(stop, list):
        options["stop"] = [s for s in stop if isinstance(s, str)]
    # `max_completion_tokens` is the newer name of the same limit. Ollama's
    # compatible endpoint reads only the older one, so the one token the
    # prewarm asks for was never a limit there. Here it is.
    limit = body.get("max_tokens") if body.get("max_tokens") is not None else body.get("max_completion_tokens")
    if limit is not None:
        options["num_predict"] = limit
    # The compatibility layer sets these two when the request leaves them
    # out, and a session must sound the same on either road.
    options["temperature"] = body["temperature"] if body.get("temperature") is not None else 1.0
    options["top_p"] = body["top_p"] if body.get("top_p") is not None else 1.0
    for name in ("seed", "frequency_penalty", "presence_penalty"):
        if body.get(name) is not None:
            options[name] = body[name]
    options["num_ctx"] = num_ctx

    native: dict[str, Any] = {
        "model": body.get("model", ""),
        "messages": _native_messages(body.get("messages") or []),
        "options": options,
        "stream": bool(body.get("stream")),
    }
    if body.get("tools"):
        native["tools"] = body["tools"]
    response_format = body.get("response_format")
    if isinstance(response_format, dict):
        kind = str(response_format.get("type", "")).strip().lower()
        if kind == "json_object":
            native["format"] = "json"
        elif kind == "json_schema" and isinstance(response_format.get("json_schema"), dict):
            schema = response_format["json_schema"].get("schema")
            if schema is not None:
                native["format"] = schema
    think = _think(body)
    if think is not None:
        native["think"] = think
    if body.get("keep_alive") is not None:
        native["keep_alive"] = body["keep_alive"]
    return native


def _openai_tool_calls(calls: list[dict]) -> list[dict]:
    out = []
    for position, call in enumerate(calls):
        function = call.get("function") or {}
        out.append({
            "id": call.get("id") or "call_" + secrets.token_hex(4),
            "index": function.get("index", position),
            "type": "function",
            "function": {"name": function.get("name", ""), "arguments": json.dumps(function.get("arguments") or {})},
        })
    return out


def _usage(native: dict) -> dict:
    prompt = int(native.get("prompt_eval_count") or 0)
    answer = int(native.get("eval_count") or 0)
    return {"prompt_tokens": prompt, "completion_tokens": answer, "total_tokens": prompt + answer}


def to_openai_completion(completion_id: str, native: dict) -> dict:
    """One finished /api/chat answer as a chat completion."""
    message = native.get("message") or {}
    calls = _openai_tool_calls(message.get("tool_calls") or [])
    reason = native.get("done_reason") or None
    if reason == "stop" and calls:
        reason = "tool_calls"
    out_message: dict[str, Any] = {"role": message.get("role", "assistant"), "content": message.get("content", "")}
    if message.get("thinking"):
        out_message["reasoning"] = message["thinking"]
    if calls:
        out_message["tool_calls"] = calls
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": native.get("model", ""),
        "system_fingerprint": "fp_ollama",
        "choices": [{"index": 0, "message": out_message, "finish_reason": reason}],
        "usage": _usage(native),
    }


class StreamTranslation:
    """Lines of an /api/chat stream in, chat completion chunks out."""

    def __init__(self, completion_id: str, include_usage: bool):
        self._id = completion_id
        self._include_usage = include_usage
        self._created = int(time.time())
        self._role_sent = False
        self._tool_call_sent = False

    def _chunk(self, model: str, delta: dict, finish: str | None = None) -> dict:
        return {
            "id": self._id,
            "object": "chat.completion.chunk",
            "created": self._created,
            "model": model,
            "system_fingerprint": "fp_ollama",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    def feed(self, native: dict) -> list[dict]:
        """The chunks one line of the stream becomes. A line with `error` becomes that error."""
        if native.get("error"):
            return [{"error": {"message": str(native["error"]), "type": "api_error", "param": None, "code": None}}]
        model = native.get("model", "")
        message = native.get("message") or {}
        thinking = message.get("thinking") or ""
        content = message.get("content") or ""
        calls = _openai_tool_calls(message.get("tool_calls") or [])
        if calls:
            self._tool_call_sent = True

        def delta(**fields) -> dict:
            d: dict[str, Any] = {}
            if not self._role_sent:
                d["role"] = "assistant"
                self._role_sent = True
            d.update(fields)
            return d

        chunks: list[dict] = []
        if thinking and (content or calls):
            # A thought and an answer in one line go out as two chunks.
            chunks.append(self._chunk(model, delta(reasoning=thinking)))
            second: dict[str, Any] = {"content": content}
            if calls:
                second["tool_calls"] = calls
            chunks.append(self._chunk(model, delta(**second)))
        else:
            fields: dict[str, Any] = {"content": content}
            if thinking:
                fields["reasoning"] = thinking
            if calls:
                fields["tool_calls"] = calls
            chunks.append(self._chunk(model, delta(**fields)))

        if native.get("done"):
            reason = native.get("done_reason") or "stop"
            if reason == "stop" and self._tool_call_sent:
                reason = "tool_calls"
            chunks.append(self._chunk(model, {}, reason))
            if self._include_usage:
                last = self._chunk(model, {})
                last["choices"] = []
                last["usage"] = _usage(native)
                chunks.append(last)
        return chunks


def _error_body(status: int, raw: bytes) -> dict:
    """An /api/chat error (`{"error": "..."}`) in the shape the OpenAI client reads."""
    message = ""
    try:
        parsed = json.loads(raw)
        said = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(said, dict):
            return {"error": said}
        if isinstance(said, str):
            message = said
    except ValueError:
        message = raw.decode("utf-8", "replace").strip()
    kind = "invalid_request_error" if status == 400 else "not_found_error" if status == 404 else "api_error"
    return {"error": {"message": message, "type": kind, "param": None, "code": None}}


class _TranslatedStream(httpx.AsyncByteStream):
    def __init__(self, upstream: httpx.Response, translation: StreamTranslation):
        self._upstream = upstream
        self._translation = translation

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for line in self._upstream.aiter_lines():
            line = line.strip()
            if not line:
                continue
            try:
                native = json.loads(line)
            except ValueError:
                continue
            if not isinstance(native, dict):
                continue
            for chunk in self._translation.feed(native):
                yield ("data: %s\n\n" % json.dumps(chunk)).encode()
            if native.get("done") or native.get("error"):
                break
        yield b"data: [DONE]\n\n"

    async def aclose(self) -> None:
        await self._upstream.aclose()


class OllamaNativeTransport(httpx.AsyncBaseTransport):
    """Carries chat completions requests to /api/chat and nothing else anywhere else.

    One way back, decided once per session and only before the native API
    has answered a request: /api/chat says 404 or 405, and /api/version on
    the same server does not answer as the native API does either. Then the
    server is alive and the native API is not reachable on it, and every
    request of this session goes to the compatible endpoint unchanged.

    Nothing else leads there. A request that ran into its limit, one that
    was cancelled, a connection that failed and every answer of the native
    API itself (a model that is not there is a 404 with /api/version
    answering) are passed on as they are, so that no real failure hides
    behind another road.
    """

    def __init__(self, num_ctx: int, inner: httpx.AsyncBaseTransport | None = None):
        self._num_ctx = num_ctx
        self._inner = inner or httpx.AsyncHTTPTransport()
        # None until the first answer decided it, then "native" or "compatible".
        self._road: str | None = None

    async def _native_api_answers(self, request: httpx.Request, root: str, headers: dict) -> bool:
        """Whether /api/version answers the way the native API does. Raises what the connection raises."""
        probe = httpx.Request(
            "GET",
            request.url.copy_with(path=root + NATIVE_VERSION_PATH, query=None),
            headers={k: v for k, v in headers.items() if k == "authorization"},
            extensions={k: v for k, v in request.extensions.items() if k == "timeout"},
        )
        answer = await self._inner.handle_async_request(probe)
        try:
            raw = await answer.aread()
        finally:
            await answer.aclose()
        if answer.status_code != 200:
            return False
        try:
            body = json.loads(raw)
        except ValueError:
            return False
        return isinstance(body, dict) and isinstance(body.get("version"), str)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method != "POST" or not path.endswith(CHAT_COMPLETIONS_SUFFIX):
            return await self._inner.handle_async_request(request)
        if self._road == "compatible":
            return await self._inner.handle_async_request(request)
        raw = await request.aread()
        try:
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise UnsupportedRequest("the request body is not an object")
            native = to_native_request(body, self._num_ctx)
        except (ValueError, UnsupportedRequest) as e:
            return httpx.Response(400, json=_error_body(400, json.dumps({"error": str(e)}).encode()), request=request)

        # `<root>/v1/chat/completions` becomes `<root>/api/chat`.
        root = path[: -len(CHAT_COMPLETIONS_SUFFIX)]
        if root.endswith("/v1"):
            root = root[: -len("/v1")]
        headers = {"content-type": "application/json", "accept": "application/x-ndjson" if native["stream"] else "application/json"}
        if "authorization" in request.headers:
            headers["authorization"] = request.headers["authorization"]
        upstream_request = httpx.Request(
            "POST",
            request.url.copy_with(path=root + NATIVE_CHAT_PATH, query=None),
            headers=headers,
            content=json.dumps(native).encode(),
            extensions={k: v for k, v in request.extensions.items() if k == "timeout"},
        )
        upstream = await self._inner.handle_async_request(upstream_request)
        upstream.request = upstream_request

        completion_id = "chatcmpl-" + secrets.token_hex(6)
        if upstream.status_code != 200:
            try:
                failed = await upstream.aread()
            finally:
                await upstream.aclose()
            if self._road is None and upstream.status_code in _NO_SUCH_PATH:
                if await self._native_api_answers(request, root, headers):
                    self._road = "native"
                else:
                    self._road = "compatible"
                    logger.warning(
                        "The model server answered {} with HTTP {} and does not answer {} either: this session uses the "
                        "OpenAI compatible endpoint and names no context window.",
                        NATIVE_CHAT_PATH, upstream.status_code, NATIVE_VERSION_PATH,
                    )
                    return await self._inner.handle_async_request(
                        httpx.Request(request.method, request.url, headers=request.headers, content=raw, extensions=request.extensions)
                    )
            return httpx.Response(upstream.status_code, json=_error_body(upstream.status_code, failed), request=request)
        self._road = "native"
        if native["stream"]:
            include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_TranslatedStream(upstream, StreamTranslation(completion_id, include_usage)),
                request=request,
            )
        try:
            answered = await upstream.aread()
        finally:
            await upstream.aclose()
        try:
            native_answer = json.loads(answered)
        except ValueError:
            return httpx.Response(502, json=_error_body(502, b'{"error": "the model server sent an answer that is not JSON"}'), request=request)
        return httpx.Response(200, json=to_openai_completion(completion_id, native_answer), request=request)

    async def aclose(self) -> None:
        await self._inner.aclose()
