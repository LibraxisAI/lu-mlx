"""Tool calls travel to the app and back. Nothing is executed here.

The LLM service announces a call, Pipecat's RTVI observer sends
`llm-function-call-in-progress` to the client, and the app runs the tool
through its own registry and permission system. The handler below only parks
the call until the client answers with `llm-function-call-result`. There is
no code path in this process that runs a tool.
"""

import asyncio
import json
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    FunctionCallResultFrame,
    FunctionCallResultProperties,
    LLMContextFrame,
    LLMFullResponseStartFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIProcessor
from pipecat.services.llm_service import FunctionCallParams, LLMService

from .config import SessionConfig

# Same ceiling the app's bridge applies to a result text.
MAX_RESULT_CHARS = 65_536

# The upstream hook this module replaces. A test fails if a Pipecat upgrade
# renames it, because results would then bypass the relay.
RESULT_HOOK = "_handle_function_call_result"


def result_for_llm(result: Any) -> str:
    """Turn the app's result envelope into the text the model reads."""
    if isinstance(result, dict):
        if result.get("status") == "completed" and isinstance(result.get("text"), str):
            text = result["text"][:MAX_RESULT_CHARS]
            return text + "\n[output truncated]" if result.get("truncated") else text
        if isinstance(result.get("error"), str):
            return "Error: " + result["error"][:MAX_RESULT_CHARS]
        return json.dumps(result, ensure_ascii=False)[:MAX_RESULT_CHARS]
    return str(result)[:MAX_RESULT_CHARS]


# Said when a tool that holds the answer takes longer than a moment, so the
# line does not go silent. Once, and not again for a while.
FILLER = "One moment."
FILLER_AFTER_SECS = 2.5
FILLER_GAP_SECS = 20.0


_CANCELLED = object()


def is_progress(result: Any) -> bool:
    """An interim report from the app: the call goes on."""
    return isinstance(result, dict) and result.get("status") == "progress"


class _Pending:
    def __init__(self, name: str, long_running: bool):
        self.name = name
        self.long_running = long_running
        self.queue: asyncio.Queue = asyncio.Queue()
        self.settled = False


class ToolRelay:
    """Parks each LLM tool call until the app delivers its result."""

    def __init__(self, long_running: frozenset[str] = frozenset(), *, filler_after_secs: float = FILLER_AFTER_SECS):
        self._pending: dict[str, _Pending] = {}
        self._long_running = long_running
        self._filler_after_secs = filler_after_secs
        self._last_filler = float("-inf")

    @property
    def pending_ids(self) -> list[str]:
        return list(self._pending)

    async def handle(self, params: FunctionCallParams) -> None:
        """The handler registered for every offered tool. Waits, never runs."""
        entry = _Pending(params.function_name, params.function_name in self._long_running)
        self._pending[params.tool_call_id] = entry
        # A long running tool lets the conversation go on, so the model says
        # itself that it started. Every other tool holds the answer.
        filler = None if entry.long_running else asyncio.create_task(self._fill_the_silence(params))
        try:
            while True:
                # Pipecat cancels this wait on timeout, on interruption (for
                # tools that are not long running) and when the session ends.
                result = await entry.queue.get()
                if result is _CANCELLED:
                    raise asyncio.CancelledError()
                if not is_progress(result):
                    break
                if entry.long_running:
                    # Into the context, without a spoken answer: the model can
                    # say how far the task is when the user asks.
                    await params.result_callback(
                        _progress_text(result), properties=FunctionCallResultProperties(is_final=False, run_llm=False),
                    )
        finally:
            self._pending.pop(params.tool_call_id, None)
            if filler:
                filler.cancel()
        await params.result_callback(result_for_llm(result))

    async def _fill_the_silence(self, params: FunctionCallParams) -> None:
        await asyncio.sleep(self._filler_after_secs)
        now = asyncio.get_running_loop().time()
        if now - self._last_filler < FILLER_GAP_SECS:
            return
        self._last_filler = now
        await params.llm.push_frame(TTSSpeakFrame(FILLER, append_to_context=False))

    def resolve(self, tool_call_id: str, function_name: str, result: Any) -> bool:
        """Deliver the app's result. Unknown, finished or mismatched calls are dropped."""
        entry = self._pending.get(tool_call_id)
        if entry is None:
            # Normal after a cancel: the app answers a call that is already over.
            return False
        if entry.name != function_name or entry.settled:
            logger.warning("Dropped a tool result that does not match its call.")
            return False
        if not is_progress(result):
            entry.settled = True
        entry.queue.put_nowait(result)
        return True

    def cancel_all(self) -> None:
        """The session is over: every parked call ends as cancelled."""
        for entry in list(self._pending.values()):
            entry.settled = True
            entry.queue.put_nowait(_CANCELLED)
        self._pending.clear()


def _progress_text(result: dict) -> str:
    text = result.get("text")
    return "Still running. %s" % text[:500] if isinstance(text, str) and text else "Still running."


class RelayRTVIProcessor(RTVIProcessor):
    """RTVI processor whose function call results go to the relay only.

    The stock processor pushes a client supplied result straight into the
    pipeline as a FunctionCallResultFrame. That would let a client message
    write a tool result into the context for a call that was never made, and
    it would leave the LLM service's own call unsettled. Here a result is
    accepted only for a call this session is waiting on.
    """

    def __init__(self, relay: ToolRelay, **kwargs):
        super().__init__(**kwargs)
        self._relay = relay

    async def _handle_function_call_result(self, data) -> None:
        self._relay.resolve(data.tool_call_id, data.function_name, data.result)


def tools_schema(config: SessionConfig) -> ToolsSchema | None:
    if not config.tools:
        return None
    return ToolsSchema(standard_tools=[
        FunctionSchema(
            name=t.function.name,
            description=t.function.description,
            properties=t.function.parameters.get("properties", {}),
            required=t.function.parameters.get("required", []),
        )
        for t in config.tools
    ])


def register_tools(llm: LLMService, relay: ToolRelay, config: SessionConfig) -> None:
    """Point every offered tool at the relay.

    Only offered names are registered. A name the model invents gets Pipecat's
    missing function answer and never a handler.
    """
    long_running = set(config.long_running_tools)
    for name in config.tool_names():
        is_long = name in long_running
        llm.register_function(
            name,
            relay.handle,
            cancel_on_interruption=not is_long,
            cancellable_by_llm=is_long,
            timeout_secs=config.tool_timeout_secs,
        )


# How long a spoken answer may take to start after the user fell silent
# before the result is considered unanswered. A turn with words in it starts
# the model within milliseconds.
OWED_GRACE_SECS = 0.5


class OwedAnswer(FrameProcessor):
    """Makes sure a tool result is answered when it lands while the user speaks.

    Pipecat does not run the model for a result that arrives during a user
    turn: the end of the turn runs it, with the result and the user's words in
    one request. A turn that ends without words for the model never does. That
    is every "yes", "no" or "stop" the command gate takes out, and every cough
    the speech recognition makes nothing of. The result then sits in the
    context and the assistant stays silent, which a user in a voice session
    reads as a hang.

    This processor sits directly before the assistant aggregator, so it sees
    the same frames in the same order. When a final result passed during a
    user turn and no answer started shortly after the turn ended, it asks for
    one.
    """

    def __init__(self, context, *, grace_secs: float = OWED_GRACE_SECS, **kwargs):
        super().__init__(**kwargs)
        self._context = context
        self._grace_secs = grace_secs
        self._user_speaking = False
        self._owed = False
        self._answers_started = 0
        self._waiting: asyncio.Task | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, UserStartedSpeakingFrame):
                self._user_speaking = True
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self._user_speaking = False
                if self._owed and self._waiting is None:
                    self._waiting = self.create_task(self._answer_if_nobody_does(self._answers_started))
            elif isinstance(frame, LLMFullResponseStartFrame):
                self._answers_started += 1
                self._owed = False
            elif isinstance(frame, FunctionCallResultFrame) and self._user_speaking:
                final = frame.properties is None or frame.properties.is_final is not False
                wants_answer = frame.properties is None or frame.properties.run_llm is not False
                if final and wants_answer:
                    self._owed = True
        await self.push_frame(frame, direction)

    async def _answer_if_nobody_does(self, answers_before: int) -> None:
        try:
            await asyncio.sleep(self._grace_secs)
            if self._owed and not self._user_speaking and self._answers_started == answers_before:
                self._owed = False
                # The same request the assistant aggregator sends after a result.
                await self.push_frame(LLMContextFrame(context=self._context), FrameDirection.UPSTREAM)
        finally:
            self._waiting = None
