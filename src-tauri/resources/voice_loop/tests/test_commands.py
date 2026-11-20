"""Spoken yes, no and stop: what counts, and that it never reaches the model."""

import asyncio
import json
from pathlib import Path

import pytest
from pipecat.frames.frames import TranscriptionFrame, TTSSpeakFrame
from pipecat.tests.utils import run_test

from lu_voice_loop.commands import BLANK, NEEDS_CLICK, VoiceCommandGate, normalize, spoken_command

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "voice_commands.json").read_text())


def heard(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text, "user", "2026-10-06T00:00:00Z")


@pytest.mark.parametrize("command", ["yes", "no", "stop"])
def test_whole_utterances_are_commands(command):
    for text in VECTORS[command]:
        assert spoken_command(text) == command, text


def test_everything_else_is_conversation():
    for text in VECTORS["none"]:
        assert spoken_command(text) is None, text


def test_normalize_drops_case_and_punctuation():
    assert normalize("Yes, please.") == "yes please"
    assert normalize("  DON'T!  ") == "dont"


async def gate_run(prepare, *texts):
    told = []

    async def notify(data):
        told.append(data)

    gate = VoiceCommandGate(notify)
    prepare(gate)
    down, _ = await run_test(gate, frames_to_send=[heard(t) for t in texts])
    passed = [f.text for f in down if isinstance(f, TranscriptionFrame) and f.text.strip()]
    spoken = [f.text for f in down if isinstance(f, TTSSpeakFrame)]
    return told, passed, spoken


async def test_nothing_is_taken_while_nothing_is_asked_and_no_task_runs():
    told, passed, _ = await gate_run(lambda g: None, "Yes.", "No.", "Stop.")
    assert told == []
    assert passed == ["Yes.", "No.", "Stop."]


async def test_stop_ends_a_running_task_and_never_reaches_the_model():
    told, passed, _ = await gate_run(lambda g: g.set_task_active(True), "Stop it.", "What are you doing?", "Yes.")
    assert told == [{"type": "voice-stop"}]
    # Without an open question, yes is an ordinary word.
    assert passed == ["What are you doing?", "Yes."]


async def test_yes_and_no_answer_the_open_question_once():
    told, passed, _ = await gate_run(lambda g: g.open_question("q1", True), "Yes, please.", "Yes.")
    assert told == [{"type": "voice-answer", "id": "q1", "answer": "yes"}]
    # The question is answered. The second yes is conversation again.
    assert passed == ["Yes."]

    told, passed, _ = await gate_run(lambda g: g.open_question("q2", True), "No.")
    assert told == [{"type": "voice-answer", "id": "q2", "answer": "no"}]
    assert passed == []


async def test_a_sentence_during_a_question_goes_to_the_model():
    told, passed, _ = await gate_run(lambda g: g.open_question("q1", True), "Yes but first tell me what you will click.")
    assert told == []
    assert passed == ["Yes but first tell me what you will click."]


async def test_a_question_that_needs_a_click_takes_no_spoken_yes():
    told, passed, spoken = await gate_run(lambda g: g.open_question("q1", False), "Yes.", "Yes!", "No.")
    # Declining is always safe. Agreeing is not, so both yeses are swallowed
    # and the user is told once where to answer.
    assert told == [{"type": "voice-answer", "id": "q1", "answer": "no"}]
    assert passed == []
    assert spoken == [NEEDS_CLICK]


async def test_stop_also_ends_the_question():
    def prepare(gate):
        gate.set_task_active(True)
        gate.open_question("q1", True)
    told, passed, _ = await gate_run(prepare, "Stop.", "Yes.")
    assert told == [{"type": "voice-stop"}]
    assert passed == ["Yes."]


async def test_a_closed_question_and_a_finished_task_disarm_the_gate():
    def closed(gate):
        gate.open_question("q1", True)
        gate.close_question("other")
        gate.close_question("q1")
    assert (await gate_run(closed, "Yes."))[1] == ["Yes."]

    def finished(gate):
        gate.set_task_active(True)
        gate.open_question("q1", True)
        gate.set_task_active(False)
    told, passed, _ = await gate_run(finished, "Yes.", "Stop.")
    assert told == [] and passed == ["Yes.", "Stop."]


async def test_a_taken_command_leaves_a_blank_transcript_so_the_turn_can_end():
    async def notify(_data):
        pass

    gate = VoiceCommandGate(notify)
    gate.open_question("q1", True)
    down, _ = await run_test(gate, frames_to_send=[heard("Yes."), heard("And then?")])
    texts = [f.text for f in down if isinstance(f, TranscriptionFrame)]
    # Pipecat's turn detection wants a transcript with text before it ends the
    # user's turn; its context keeps only one that is more than whitespace.
    assert texts == [BLANK, "And then?"]
    assert BLANK and not BLANK.strip()


# ---- "wait" as a command and "Wait, ..." as the start of a sentence -----------
#
# Windows run A22, 11.16: "Wait, what is two plus two?" paused the task. The
# speech recognition had delivered "Wait" as a piece of its own.

from pipecat.frames.frames import VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame  # noqa: E402
from pipecat.tests.utils import SleepFrame  # noqa: E402

from lu_voice_loop.commands import HOLD, HOLD_GRACE_SECS, STOP, holds_only  # noqa: E402

GRACE = 0.1
# Speaking frames are system frames and overtake queued ones, so every step
# is given the time to be handled before the next one is sent.
STEP = SleepFrame(0.02)
SPEECH = VADUserStartedSpeakingFrame
SILENCE = VADUserStoppedSpeakingFrame


async def task_run(*steps):
    """A running task hears these pieces: texts, speaking frames and waits."""
    told = []

    async def notify(data):
        told.append(data)

    gate = VoiceCommandGate(notify, hold_grace_secs=GRACE)
    gate.set_task_active(True)
    frames = []
    for step in steps:
        frames += [heard(step) if isinstance(step, str) else step, STEP]
    down, _ = await run_test(gate, frames_to_send=frames)
    texts = [f.text for f in down if isinstance(f, TranscriptionFrame)]
    return told, [t for t in texts if t.strip()], texts


@pytest.mark.parametrize("word", ["Wait.", "wait a moment", "Hold on.", "Pause.", "Pause it."])
async def test_the_word_alone_pauses_once_nothing_follows(word):
    told, passed, texts = await task_run(SPEECH(), SILENCE(), word, SleepFrame(GRACE * 3))
    assert told == [{"type": "voice-stop"}]
    assert passed == []
    # The turn still ends: the blank transcript stands in for the word.
    assert texts == [BLANK]


async def test_nothing_is_paused_before_the_moment_is_over():
    told, passed, _ = await task_run(SPEECH(), SILENCE(), "Wait.", SleepFrame(GRACE / 4), SPEECH())
    assert told == []
    assert passed == ["Wait."]


async def test_wait_followed_by_a_question_is_conversation():
    told, passed, _ = await task_run(
        SPEECH(), SILENCE(), "Wait,", SPEECH(), SILENCE(), "what is two plus two?", SleepFrame(GRACE * 3),
    )
    assert told == []
    assert passed == ["Wait,", "what is two plus two?"]


async def test_wait_heard_while_the_user_already_says_the_rest_is_conversation():
    # The recognition of the first piece took longer than the breath after it.
    told, passed, _ = await task_run(SPEECH(), SILENCE(), SPEECH(), "Wait,", SILENCE(), "what is on the screen?", SleepFrame(GRACE * 3))
    assert told == []
    assert passed == ["Wait,", "what is on the screen?"]


async def test_more_words_without_a_sign_of_speech_release_the_word_too():
    told, passed, _ = await task_run("Hold on.", "I have a question.", SleepFrame(GRACE * 3))
    assert told == []
    assert passed == ["Hold on.", "I have a question."]


async def test_stop_is_never_held_back():
    # No wait after the word: the task is told before anything else arrives.
    told, passed, _ = await task_run(SPEECH(), SILENCE(), "Stop.")
    assert told == [{"type": "voice-stop"}]
    told, passed, _ = await task_run(SPEECH(), SILENCE(), "Stop.", SPEECH(), SILENCE(), "What are you doing?", SleepFrame(GRACE * 3))
    assert told == [{"type": "voice-stop"}]
    assert passed == ["What are you doing?"]


async def test_two_waits_in_a_row_are_a_sentence_and_the_next_one_alone_pauses():
    told, passed, _ = await task_run("Wait.", "Wait.", SleepFrame(GRACE * 3))
    # The second one stood alone at the end.
    assert told == [{"type": "voice-stop"}]
    assert passed == ["Wait."]


async def test_a_task_that_ended_meanwhile_leaves_the_word_an_ordinary_word():
    told = []

    async def notify(data):
        told.append(data)

    gate = VoiceCommandGate(notify, hold_grace_secs=GRACE)
    gate.set_task_active(True)

    async def end_task():
        await asyncio.sleep(GRACE / 3)
        gate.set_task_active(False)

    ender = asyncio.create_task(end_task())
    down, _ = await run_test(gate, frames_to_send=[heard("Wait."), SleepFrame(GRACE * 3)])
    await ender
    assert told == []
    assert [f.text for f in down if isinstance(f, TranscriptionFrame)] == ["Wait."]


def test_the_words_that_are_held_are_stop_words_and_the_plain_stops_are_not_among_them():
    assert HOLD < STOP
    for word in ["stop", "stop it", "please stop", "cancel", "abort", "stop everything"]:
        assert word in STOP and not holds_only(word), word
    for text in ["Wait.", "Hold on.", "pause", "Wait a second"]:
        assert holds_only(text) and spoken_command(text) == "stop", text
    assert not holds_only("Wait, what is two plus two?")
    assert spoken_command("Wait, what is two plus two?") is None
    # Long enough for a breath, short enough that "wait" still feels heard.
    assert 0.3 <= HOLD_GRACE_SECS <= 1.0
