"""A tool result that lands while the user speaks is answered, also when the
user's turn had no words for the model (a spoken yes that the command gate
took, a cough)."""

from pipecat.frames.frames import (
    FunctionCallResultFrame,
    FunctionCallResultProperties,
    LLMContextFrame,
    LLMFullResponseStartFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.tests.utils import SleepFrame, run_test

from lu_voice_loop.tools import OwedAnswer

GRACE = 0.05
# Speaking frames are system frames and overtake queued ones, so every step
# is given the time to be handled before the next one is sent.
STEP = SleepFrame(0.02)


def result(properties=None) -> FunctionCallResultFrame:
    return FunctionCallResultFrame("computer_task", "call-1", {"goal": "save"}, {"status": "completed", "text": "Saved."}, properties=properties)


async def asked_again(*frames) -> int:
    context = LLMContext()
    steps = []
    for frame in frames:
        steps += [frame, STEP]
    _, up = await run_test(OwedAnswer(context, grace_secs=GRACE), frames_to_send=[*steps, SleepFrame(GRACE * 4)])
    asks = [f for f in up if isinstance(f, LLMContextFrame)]
    assert all(f.context is context for f in asks)
    return len(asks)


async def test_a_result_during_a_turn_without_words_is_answered_once():
    assert await asked_again(UserStartedSpeakingFrame(), result(), UserStoppedSpeakingFrame()) == 1


async def test_a_turn_with_words_answers_by_itself():
    # The end of a turn with words starts the model, which then has the result too.
    assert await asked_again(UserStartedSpeakingFrame(), result(), UserStoppedSpeakingFrame(), LLMFullResponseStartFrame()) == 0


async def test_a_result_while_nobody_speaks_is_left_to_pipecat():
    assert await asked_again(result()) == 0
    assert await asked_again(UserStartedSpeakingFrame(), UserStoppedSpeakingFrame(), result()) == 0


async def test_an_interim_report_is_not_an_answer_owed():
    progress = FunctionCallResultProperties(is_final=False, run_llm=False)
    assert await asked_again(UserStartedSpeakingFrame(), result(progress), UserStoppedSpeakingFrame()) == 0


async def test_a_result_that_asks_for_no_answer_gets_none():
    assert await asked_again(UserStartedSpeakingFrame(), result(FunctionCallResultProperties(run_llm=False)), UserStoppedSpeakingFrame()) == 0


async def test_it_waits_while_the_user_keeps_talking_and_answers_after():
    assert await asked_again(
        UserStartedSpeakingFrame(), result(), UserStoppedSpeakingFrame(),
        UserStartedSpeakingFrame(), SleepFrame(GRACE * 3), UserStoppedSpeakingFrame(),
    ) == 1
