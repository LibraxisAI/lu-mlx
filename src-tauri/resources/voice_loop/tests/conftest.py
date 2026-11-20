"""Test harness: the real server and pipeline, with stand-ins for the heavy parts.

The speech models are replaced by tiny fakes, the LLM is a scripted
OpenAI-compatible server on loopback. Everything between them is the real
code: HTTP guards, tickets, WebSocket transport, RTVI, the tool relay.
"""

import asyncio
import json
import os
import socket
import sys
from contextlib import asynccontextmanager

import httpx
import pytest
import torch
import uvicorn
import websockets
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from loguru import logger

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lu_voice_loop.engines import Engines  # noqa: E402
from lu_voice_loop.server import VoiceServer  # noqa: E402
from wire import client_ready, parse  # noqa: E402

def quiet_test_logging() -> None:
    """Warnings only, written to whatever stderr is current (pytest swaps it per test)."""
    logger.remove()
    logger.add(lambda message: sys.stderr.write(message), level="WARNING")


quiet_test_logging()

TOKEN = "test-token-" + "x" * 32
ORIGIN = "tauri://localhost"

CLOCK_TOOL = {
    "type": "function",
    "function": {
        "name": "get_current_time",
        "description": "Returns the current local time.",
        "parameters": {"type": "object", "properties": {"zone": {"type": "string"}}, "required": []},
    },
}


class FakeWhisper:
    def transcribe(self, audio, **kwargs):
        return [], None


class FakeTTS:
    sample_rate = 24000

    def generate_audio_stream(self, voice_state, text, copy_state=True):
        for _ in range(3):
            yield torch.zeros(1920)


def fake_engines() -> Engines:
    return Engines(whisper=FakeWhisper(), tts=FakeTTS(), voice_states={"alba": object()})


def _bound_socket() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    return sock


@asynccontextmanager
async def _serve(app, sock):
    server = uvicorn.Server(uvicorn.Config(app, log_config=None, access_log=False, lifespan="off"))
    server.install_signal_handlers = lambda: None
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        await asyncio.sleep(0.01)
    try:
        yield
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)


def _chunk(delta: dict, finish: str | None = None) -> str:
    body = {
        "id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 0, "model": "fake",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return "data: %s\n\n" % json.dumps(body)


def text_reply(text: str) -> list[str]:
    return [_chunk({"role": "assistant", "content": text}), _chunk({}, "stop"), "data: [DONE]\n\n"]


def tool_reply(name: str, arguments: dict, call_id: str = "call_abc123") -> list[str]:
    call = {"index": 0, "id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
    return [_chunk({"role": "assistant", "tool_calls": [call]}), _chunk({}, "tool_calls"), "data: [DONE]\n\n"]


def _native(message: dict, done: bool = False, **more) -> dict:
    line = {"model": "fake", "created_at": "2026-10-10T12:00:00Z", "message": {"role": "assistant", "content": "", **message}, "done": done}
    line.update(more)
    return line


def native_text_reply(text: str) -> list[dict]:
    """A spoken answer as /api/chat sends it: the text, then the closing line with the counts."""
    return [_native({"content": text}), _native({}, done=True, done_reason="stop", prompt_eval_count=12, eval_count=3)]


def native_tool_reply(name: str, arguments: dict, call_id: str = "call_abc123") -> list[dict]:
    call = {"id": call_id, "function": {"index": 0, "name": name, "arguments": arguments}}
    return [_native({"tool_calls": [call]}), _native({}, done=True, done_reason="stop", prompt_eval_count=12, eval_count=5)]


class FakeLLM:
    """Scripted model server: the OpenAI-compatible endpoint and Ollama's own chat API."""

    def __init__(self):
        self.requests: list[dict] = []
        self.headers: list[dict] = []
        # Called with the request body, returns the SSE lines to stream.
        self.script = lambda body: text_reply("Hello there.")
        # Called with the body of a request that does not stream.
        self.one_shot = lambda body: "The user said hello."
        self.status = 200
        # What a refused request is answered with.
        self.refusal = '{"error": {"message": "upstream failed"}}'
        self.app = FastAPI()

        @self.app.post("/v1/chat/completions")
        async def completions(request: Request):
            body = await request.json()
            self.requests.append(body)
            self.headers.append(dict(request.headers))
            # A number, or a function of the request body for a server that
            # refuses only some requests.
            status = self.status(body) if callable(self.status) else self.status
            if status != 200:
                return StreamingResponse(iter([self.refusal]), status_code=status, media_type="application/json")
            if not body.get("stream"):
                # A one shot request: the prewarm, or a summary of the conversation.
                return {
                    "id": "chatcmpl-test", "object": "chat.completion", "created": 0, "model": "fake",
                    "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": self.one_shot(body)}}],
                }
            lines = self.script(body)
            return StreamingResponse(iter(lines), media_type="text/event-stream")

        # Ollama's own chat API, for a session the app gave a context window
        # (lu_voice_loop/ollama_native.py). Bodies land in `native_requests`.
        self.native_requests: list[dict] = []
        self.native_headers: list[dict] = []
        # Called with the request body, returns the objects of the answer:
        # one line each for a stream, the single answer otherwise.
        self.native_script = lambda body: native_text_reply("Hello there.")
        self.native_status = 200
        self.native_refusal = '{"error": "upstream failed"}'
        # False for a server that speaks only the compatible endpoint: a
        # proxy that lets /v1 through and answers every other path with 404.
        self.native_api = True
        self.version_requests = 0

        @self.app.get("/api/version")
        async def native_version():
            self.version_requests += 1
            if not self.native_api:
                return StreamingResponse(iter(["404 page not found"]), status_code=404, media_type="text/plain")
            return {"version": "0.0.0-test"}

        @self.app.post("/api/chat")
        async def native_chat(request: Request):
            body = await request.json()
            self.native_requests.append(body)
            self.native_headers.append(dict(request.headers))
            if not self.native_api:
                return StreamingResponse(iter(["404 page not found"]), status_code=404, media_type="text/plain")
            status = self.native_status(body) if callable(self.native_status) else self.native_status
            if status != 200:
                return StreamingResponse(iter([self.native_refusal]), status_code=status, media_type="application/json")
            lines = self.native_script(body)
            if not body.get("stream"):
                return lines[-1]
            return StreamingResponse(iter(json.dumps(line) + "\n" for line in lines), media_type="application/x-ndjson")

    def tool_messages(self) -> list[dict]:
        return [m for body in self.requests for m in body["messages"] if m.get("role") == "tool"]


class Session:
    """One connected test client."""

    def __init__(self, ws):
        self.ws = ws
        self.messages: list[dict] = []
        self.audio_frames = 0
        self._reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            async for raw in self.ws:
                kind, payload = parse(raw)
                if kind == "audio":
                    self.audio_frames += 1
                elif kind == "message":
                    self.messages.append(payload)
        except websockets.ConnectionClosed:
            pass

    def of_type(self, type_: str) -> list[dict]:
        return [m.get("data") or {} for m in self.messages if m.get("type") == type_]

    async def wait_for(self, type_: str, count: int = 1, timeout: float = 10.0) -> dict:
        async def poll():
            while len(self.of_type(type_)) < count:
                await asyncio.sleep(0.01)
            return self.of_type(type_)[count - 1]
        return await asyncio.wait_for(poll(), timeout)

    async def send(self, frame: bytes):
        await self.ws.send(frame)


class Harness:
    def __init__(self, voice: VoiceServer, llm: FakeLLM, llm_port: int):
        self.voice = voice
        self.llm = llm
        self.base = "http://127.0.0.1:%d" % voice.port
        self.llm_url = "http://127.0.0.1:%d/v1" % llm_port

    def headers(self, token: str = TOKEN, origin: str | None = ORIGIN) -> dict:
        headers = {"Authorization": "Bearer " + token}
        if origin is not None:
            headers["Origin"] = origin
        return headers

    def config(self, **overrides) -> dict:
        config = {
            "llm": {"base_url": self.llm_url, "model": "fake"},
            "system_prompt": "You are a test assistant.",
            "tools": [CLOCK_TOOL],
        }
        config.update(overrides)
        return config

    async def start(self, config: dict | None = None) -> dict:
        async with httpx.AsyncClient() as http:
            response = await http.post(self.base + "/session", json=config or self.config(), headers=self.headers())
        assert response.status_code == 200, response.text
        return response.json()

    @asynccontextmanager
    async def session(self, config: dict | None = None):
        start = await self.start(config)
        url = "%s?token=%s" % (start["wsUrl"], start["token"])
        async with websockets.connect(url, additional_headers={"Origin": ORIGIN}) as ws:
            session = Session(ws)
            await session.send(client_ready())
            await session.wait_for("bot-ready")
            yield session


@pytest.fixture
async def harness():
    llm = FakeLLM()
    llm_sock = _bound_socket()
    voice_sock = _bound_socket()
    voice = VoiceServer(token=TOKEN, origins=(ORIGIN, "http://localhost:5173"), port=voice_sock.getsockname()[1])
    voice.set_engines(fake_engines())
    async with _serve(llm.app, llm_sock), _serve(voice.app, voice_sock):
        try:
            yield Harness(voice, llm, llm_sock.getsockname()[1])
        finally:
            await voice.shutdown()
