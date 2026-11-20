"""The loopback HTTP and WebSocket surface.

    GET  /health    liveness and load state, no secrets
    POST /session   app sends the session config, gets {wsUrl, token}
    POST /sample    one fixed sentence in an installed voice, as a WAV file
    WS   /ws        RTVI over protobuf frames for @pipecat-ai/websocket-transport

POST /session answers in the shape PipecatClient.startBotAndConnect() hands to
the WebSocket transport, so the client needs no glue code.
"""

import asyncio
import io
import json
import wave
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from loguru import logger
from pydantic import ValidationError

from . import __version__
from .auth import TicketStore, bearer_matches, host_allowed, origin_allowed
from .config import VOICE_PATTERN, SessionConfig, describe_validation_error
from .engines import Engines
from .log import safe_error_text

MAX_BODY_BYTES = 1024 * 1024

# What a voice says when the user wants to hear it before choosing. Fixed
# here: this endpoint is not a way to make the engine say arbitrary text.
SAMPLE_TEXT = "Hello. This is how I sound when I answer you."


def sample_wav(engines: Engines, voice: str) -> bytes:
    """Blocking. The sample sentence in `voice`, mono 16 bit at the model's rate."""
    import torch

    state = engines.voice_state(voice)
    pcm = b"".join(
        (chunk.clamp(-1.0, 1.0) * 32767).to(torch.int16).numpy().tobytes()
        for chunk in engines.tts.generate_audio_stream(state, SAMPLE_TEXT, copy_state=True)
    )
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(engines.tts_sample_rate)
        wav.writeframes(pcm)
    return out.getvalue()

# WebSocket close codes in the application range.
WS_FORBIDDEN = 4403
WS_NOT_READY = 4503


@dataclass
class _Active:
    worker: Any
    relay: Any
    task: asyncio.Task


class VoiceServer:
    def __init__(self, *, token: str, origins: tuple[str, ...], port: int):
        self._token = token
        self._origins = origins
        self.port = port
        self.state = "loading"
        self.engines: Engines | None = None
        self._engines_ready = asyncio.Event()
        self._tickets = TicketStore()
        self._active: _Active | None = None
        self._closing = False
        # The speech model serves one caller at a time: a sample and a session
        # never synthesize side by side.
        self._sampling = asyncio.Lock()
        self.app = self._build_app()

    # ---- lifecycle -------------------------------------------------------

    def set_engines(self, engines: Engines) -> None:
        self.engines = engines
        self.state = "ready"
        self._engines_ready.set()

    def set_failed(self) -> None:
        self.state = "error"
        self._engines_ready.set()

    async def shutdown(self) -> None:
        """End the running session. Safe to call more than once."""
        self._closing = True
        await self._stop_active()

    async def _stop_active(self) -> None:
        active, self._active = self._active, None
        if active is None:
            return
        active.relay.cancel_all()
        try:
            await active.worker.cancel()
        except Exception as e:
            logger.warning("Session did not cancel cleanly (%s)." % safe_error_text(e))
        try:
            await asyncio.wait_for(asyncio.shield(active.task), timeout=3.0)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            active.task.cancel()

    # ---- guards ----------------------------------------------------------

    def _request_refusal(self, headers) -> tuple[int, str] | None:
        """Host and Origin checks shared by HTTP and WebSocket."""
        if not host_allowed(headers.get("host"), self.port):
            return 403, "This service only answers on its loopback address."
        if not origin_allowed(headers.get("origin"), self._origins):
            return 403, "This origin is not allowed to use the voice loop."
        return None

    # ---- app -------------------------------------------------------------

    def _build_app(self) -> FastAPI:
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(self._origins),
            allow_methods=["GET", "POST"],
            allow_headers=["authorization", "content-type"],
            max_age=600,
        )

        @app.get("/health")
        async def health():
            return {"status": "ok", "state": self.state, "version": __version__, "session_active": self._active is not None}

        @app.post("/session")
        async def create_session(request: Request):
            refusal = self._request_refusal(request.headers)
            if refusal:
                return JSONResponse({"error": refusal[1]}, status_code=refusal[0])
            if not bearer_matches(request.headers.get("authorization"), self._token):
                return JSONResponse({"error": "Missing or wrong voice loop token."}, status_code=401)
            if self._closing:
                return JSONResponse({"error": "The voice loop is shutting down."}, status_code=503)

            body = await request.body()
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({"error": "Session configuration is too large."}, status_code=413)
            try:
                config = SessionConfig.model_validate(json.loads(body))
            except ValidationError as e:
                return JSONResponse({"error": describe_validation_error(e)}, status_code=422)
            except (ValueError, UnicodeDecodeError):
                return JSONResponse({"error": "Session configuration is not valid JSON."}, status_code=400)

            if self.state == "error":
                return JSONResponse({"error": "The voice models failed to load."}, status_code=503)
            if self.engines is not None and not self.engines.has_voice(config.voice):
                return JSONResponse({"error": "The voice %s is not installed." % config.voice}, status_code=422)

            ticket = self._tickets.issue(config)
            return {"wsUrl": "ws://127.0.0.1:%d/ws" % self.port, "token": ticket}

        @app.post("/sample")
        async def sample(request: Request):
            refusal = self._request_refusal(request.headers)
            if refusal:
                return JSONResponse({"error": refusal[1]}, status_code=refusal[0])
            if not bearer_matches(request.headers.get("authorization"), self._token):
                return JSONResponse({"error": "Missing or wrong voice loop token."}, status_code=401)
            if self._closing:
                return JSONResponse({"error": "The voice loop is shutting down."}, status_code=503)
            body = await request.body()
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({"error": "The request is too large."}, status_code=413)
            try:
                voice = json.loads(body).get("voice")
            except (ValueError, UnicodeDecodeError, AttributeError):
                return JSONResponse({"error": "The request is not valid JSON."}, status_code=400)
            if not isinstance(voice, str) or not VOICE_PATTERN.fullmatch(voice):
                return JSONResponse({"error": "The request names no voice."}, status_code=422)
            if self.state == "error":
                return JSONResponse({"error": "The voice models failed to load."}, status_code=503)
            if self.engines is None:
                return JSONResponse({"error": "The voice models are still loading."}, status_code=503)
            if not self.engines.has_voice(voice):
                return JSONResponse({"error": "The voice %s is not installed." % voice}, status_code=422)
            if self._active is not None:
                return JSONResponse({"error": "A voice session is running. Stop it to listen to a voice."}, status_code=409)
            async with self._sampling:
                try:
                    audio = await asyncio.to_thread(sample_wav, self.engines, voice)
                except Exception as e:
                    logger.error("The voice sample failed (%s)." % safe_error_text(e))
                    return JSONResponse({"error": "The voice sample could not be made (%s)." % type(e).__name__}, status_code=500)
            return Response(content=audio, media_type="audio/wav", headers={"cache-control": "no-store"})

        @app.websocket("/ws")
        async def session_socket(websocket: WebSocket):
            # Closing before accept answers the handshake with HTTP 403.
            if self._closing or self._request_refusal(websocket.headers):
                await websocket.close(code=WS_FORBIDDEN)
                return
            config = self._tickets.redeem(websocket.query_params.get("token"))
            if config is None:
                await websocket.close(code=WS_FORBIDDEN)
                return
            await websocket.accept()
            await self._run_session(websocket, config)

        return app

    async def _run_session(self, websocket: WebSocket, config: SessionConfig) -> None:
        from .pipeline import build_worker, run_worker

        await self._engines_ready.wait()
        if self.engines is None or not self.engines.has_voice(config.voice) or self._closing:
            await websocket.close(code=WS_NOT_READY)
            return
        # A voice that was installed after this process started is loaded now,
        # off the event loop, and after a running sample has finished.
        async with self._sampling:
            try:
                await asyncio.to_thread(self.engines.voice_state, config.voice)
            except Exception as e:
                logger.error("The voice %s could not be loaded (%s)." % (config.voice, safe_error_text(e)))
                await websocket.close(code=WS_NOT_READY)
                return

        # One conversation at a time. A new session (for example after a
        # webview reload) replaces the old one.
        await self._stop_active()

        worker, relay = build_worker(websocket, config, self.engines)
        task = asyncio.current_task()
        assert task is not None
        active = _Active(worker=worker, relay=relay, task=task)
        self._active = active
        # What the model is shown, not what is registered: with the agent
        # switched off the app registers its tools and shows none of them.
        shown = len(config.tools) if config.active_tools is None else len(config.active_tools)
        logger.info("Session started (%d tools offered)." % shown)
        try:
            await run_worker(worker)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("Session ended with an error (%s)." % safe_error_text(e))
        finally:
            relay.cancel_all()
            if self._active is active:
                self._active = None
            logger.info("Session ended.")
