"""The client side of the wire, as @pipecat-ai/websocket-transport speaks it.

Binary protobuf frames on the WebSocket. Audio travels as raw PCM16 frames,
RTVI messages as JSON inside a message frame.
"""

import json
import os

from pipecat.frames.protobufs import frames_pb2

RATE = 16000


def audio_frame(pcm: bytes) -> bytes:
    frame = frames_pb2.Frame()
    frame.audio.audio = pcm
    frame.audio.sample_rate = RATE
    frame.audio.num_channels = 1
    return frame.SerializeToString()


def message_frame(message: dict) -> bytes:
    frame = frames_pb2.Frame()
    frame.message.data = json.dumps(message)
    return frame.SerializeToString()


def rtvi(type_: str, data=None, id_: str = "") -> dict:
    return {"label": "rtvi-ai", "type": type_, "id": id_ or os.urandom(4).hex(), "data": data}


def client_ready() -> bytes:
    # The protocol version @pipecat-ai/client-js 1.13.1 announces.
    return message_frame(rtvi("client-ready", {"version": "2.1.0", "about": {"library": "test-client"}}))


def tool_result(call: dict, result) -> bytes:
    """The exact message the app's VoiceToolBridge sends back."""
    return message_frame(rtvi("llm-function-call-result", {
        "function_name": call["function_name"],
        "tool_call_id": call["tool_call_id"],
        "arguments": call.get("arguments") or {},
        "result": result,
    }))


def client_message(kind: str, data=None) -> bytes:
    """What PipecatClient.sendClientMessage(kind, data) puts on the wire."""
    return message_frame(rtvi("client-message", {"t": kind, "d": data}))


def parse(raw: bytes) -> tuple[str, object]:
    """Return ("audio", bytes), ("message", dict) or (other kind, None)."""
    frame = frames_pb2.Frame.FromString(raw)
    kind = frame.WhichOneof("frame")
    if kind == "audio":
        return "audio", frame.audio.audio
    if kind == "message":
        return "message", json.loads(frame.message.data)
    return str(kind), None
