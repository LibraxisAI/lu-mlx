"""A turn whose words were a spoken command is over with the command: the
model is not asked about it. A turn without words that was no command (a
cough into the answer) is still answered."""

from pipecat.frames.frames import (
    LLMContextFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.tests.utils import SleepFrame, run_test
from pipecat.turns.empty_user_turn import DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from lu_voice_loop.commands import EmptyTurnUnlessCommand, VoiceCommandGate
from lu_voice_loop.pipeline import user_turn_params

STEP = SleepFrame(0.05)


def heard(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text, "user", "2026-10-09T00:00:00Z")


async def turn(prepare, *said: str):
    """One turn of the user that cuts into the assistant, through the gate and the real conversation."""
    told = []

    async def notify(data):
        told.append(data)

    gate = VoiceCommandGate(notify)
    prepare(gate)
    context = LLMContext()
    params = user_turn_params(
        gate,
        # The session ends a turn with Smart Turn, which needs sound. Here a short silence does.
        user_turn_strategies=UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.05)]),
        user_turn_stop_timeout=0.3,
    )
    user = LLMContextAggregatorPair(context, user_params=params).user()
    frames = [VADUserStartedSpeakingFrame(), STEP, VADUserStoppedSpeakingFrame(), STEP]
    for text in said:
        frames += [heard(text), STEP]
    down, _ = await run_test(Pipeline([gate, user]), frames_to_send=[*frames, SleepFrame(0.8)])
    asked = [f for f in down if isinstance(f, LLMContextFrame)]
    return told, asked, context.get_messages()


def question(gate):
    gate.set_task_active(True)
    gate.open_question("q1", True)


async def test_a_spoken_yes_answers_the_question_and_the_model_is_not_asked():
    # Windows run A22: after every spoken yes the model spoke about the task
    # it was still running, because the turn counted as words nobody understood.
    told, asked, messages = await turn(question, "Yes.")
    assert told == [{"type": "voice-answer", "id": "q1", "answer": "yes"}]
    assert asked == []
    assert messages == []


async def test_a_spoken_no_and_a_spoken_stop_are_not_talked_about_either():
    told, asked, messages = await turn(question, "No.")
    assert told == [{"type": "voice-answer", "id": "q1", "answer": "no"}]
    assert asked == [] and messages == []

    told, asked, messages = await turn(lambda g: g.set_task_active(True), "Stop.")
    assert told == [{"type": "voice-stop"}]
    assert asked == [] and messages == []


async def test_a_turn_nobody_understood_is_still_answered():
    # No transcript at all: a cough into the answer. Pipecat's own rule holds.
    told, asked, messages = await turn(question)
    assert told == []
    assert len(asked) == 1
    assert messages == [{"role": "developer", "content": DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT}]


async def test_a_sentence_goes_to_the_model_as_before():
    told, asked, messages = await turn(question, "Yes but first tell me what you will click.")
    assert told == []
    assert len(asked) == 1
    assert messages == [{"role": "user", "content": "Yes but first tell me what you will click."}]


async def test_the_next_turn_starts_clean():
    async def notify(_data):
        pass

    gate = VoiceCommandGate(notify)
    gate.open_question("q1", True)
    rule = EmptyTurnUnlessCommand(gate)
    assert rule.interrupted_prompt == DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT
    assert rule.idle_prompt is None
    await run_test(gate, frames_to_send=[heard("Yes.")])
    assert rule.interrupted_prompt is None
    # New speech: the yes belongs to the turn before.
    await gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.UPSTREAM)
    assert rule.interrupted_prompt == DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT
