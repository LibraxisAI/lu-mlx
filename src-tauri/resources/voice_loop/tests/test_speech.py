"""An answer may start speaking at a comma. After that, whole sentences."""

import time

import torch
from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame
from pipecat.services.tts_service import TTSService
from pipecat.tests.utils import SleepFrame, run_test

import pytest

from lu_voice_loop.speech import AGGREGATOR_FIELD, SPEAK_HOOK, ClauseFirstAggregator, SharedPocketTTSService, speakable
from conftest import fake_engines


async def pieces(aggregator, *chunks, flush=True):
    out = []
    for chunk in chunks:
        async for piece in aggregator.aggregate(chunk):
            out.append(piece.text)
    if flush:
        rest = await aggregator.flush()
        if rest:
            out.append(rest.text)
    return out


def stream(text):
    """Token sized chunks, the way a model streams."""
    words = text.split(" ")
    return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]


async def test_the_first_piece_ends_at_a_comma_when_it_is_long_enough():
    out = await pieces(ClauseFirstAggregator(), *stream("I looked at the folder, and there are three files in it. Two are pictures. One is a note."))
    assert out == ["I looked at the folder,", "and there are three files in it.", "Two are pictures.", "One is a note."]


async def test_only_the_first_piece_of_an_answer_is_cut_at_a_comma():
    out = await pieces(ClauseFirstAggregator(), *stream("That is all done now, as you asked. The second file, the large one, is still open."))
    assert out == ["That is all done now,", "as you asked.", "The second file, the large one, is still open."]


async def test_a_short_opening_is_not_cut_off():
    # "Sure," alone would be spoken and over before the sentence is written.
    out = await pieces(ClauseFirstAggregator(), *stream("Sure, I can do that. Give me a second."))
    assert out == ["Sure, I can do that.", "Give me a second."]


async def test_a_number_with_a_comma_is_not_a_clause():
    out = await pieces(ClauseFirstAggregator(), *stream("The folder holds about 1,200 files right now. That is a lot."))
    assert out == ["The folder holds about 1,200 files right now.", "That is a lot."]


async def test_each_answer_starts_fresh():
    aggregator = ClauseFirstAggregator()
    first = await pieces(aggregator, *stream("It is half past two, by the way. Anything else?"))
    second = await pieces(aggregator, *stream("The file is saved now, in your documents. Done."))
    assert first[0] == "It is half past two,"
    assert second[0] == "The file is saved now,"


async def test_an_interruption_drops_the_rest_and_starts_fresh():
    aggregator = ClauseFirstAggregator()
    assert await pieces(aggregator, *stream("I looked at the folder, and there"), flush=False) == ["I looked at the folder,"]
    await aggregator.handle_interruption()
    assert await pieces(aggregator, *stream("Stopped as you asked, no problem.")) == ["Stopped as you asked,", "no problem."]


def test_the_speech_service_uses_it_and_pipecat_still_has_the_field():
    engines = fake_engines()
    tts = SharedPocketTTSService(tts_model=engines.tts, voice_state=engines.voice_states["alba"], voice="alba")
    assert isinstance(getattr(tts, AGGREGATOR_FIELD), ClauseFirstAggregator)
    # The stock service sets this very field in its constructor.
    import inspect
    assert "self.%s = " % AGGREGATOR_FIELD in inspect.getsource(TTSService.__init__)


class SlowToStartTTS:
    """A speech model on a busy processor: the first sound takes its time."""

    sample_rate = 24000

    def __init__(self, first_sound_after_secs):
        self._wait = first_sound_after_secs

    def generate_audio_stream(self, voice_state, text, copy_state=True):
        time.sleep(self._wait)
        for _ in range(3):
            yield torch.zeros(1920)


async def test_a_sentence_whose_first_sound_comes_late_is_still_spoken_and_is_not_an_error():
    # Pipecat gives up on a sentence that brings no sound for three seconds,
    # reports it as an error, and the app ends the session on any error.
    # Seen 08.10.2026 on a Mac whose processors were all busy: two sessions
    # ended on "TTS context ... completed with no audio".
    tts = SharedPocketTTSService(tts_model=SlowToStartTTS(3.4), voice_state=object(), voice="alba")
    down, up = await run_test(tts, frames_to_send=[TTSSpeakFrame("Hello there."), SleepFrame(4.5)])
    assert [f for f in down if isinstance(f, TTSAudioRawFrame)], "the sentence was never spoken"
    assert not [f for f in [*down, *up] if isinstance(f, ErrorFrame)]


class WordsOnlyTTS:
    """The real speech model: it raises on text it finds nothing to say in."""

    sample_rate = 24000

    def __init__(self):
        self.asked: list[str] = []

    def generate_audio_stream(self, voice_state, text, copy_state=True):
        self.asked.append(text)
        if not any(ch.isalnum() for ch in text):
            raise ValueError("no words")
        import torch
        yield torch.zeros(1920)


@pytest.mark.parametrize("text", [" ", "   \n\t ", "\u00a0", "...", "***", "-", " . "])
async def test_text_without_anything_to_say_never_reaches_the_speech_model(text):
    model = WordsOnlyTTS()
    tts = SharedPocketTTSService(tts_model=model, voice_state=object(), voice="alba")
    down, up = await run_test(tts, frames_to_send=[TTSSpeakFrame(text), SleepFrame(0.2)])
    assert model.asked == []
    assert not [f for f in [*down, *up] if isinstance(f, (ErrorFrame, TTSAudioRawFrame))]


def test_pipecat_still_sends_text_to_the_speech_model_through_the_hook_that_is_overridden():
    assert callable(getattr(TTSService, SPEAK_HOOK, None))
    assert SPEAK_HOOK in vars(SharedPocketTTSService)


def test_words_and_numbers_are_spoken():
    for text in ["Hello.", " ok ", "42", "Grüße", "a"]:
        assert speakable(text), text
    for text in ["", " ", "\n", "...", "?!", "\u00a0"]:
        assert not speakable(text), repr(text)


async def test_a_sentence_without_words_between_two_spoken_ones_is_no_error_in_the_session(monkeypatch):
    # Pipecat reports a sentence that brought no sound once its patience is over. Here: one second.
    monkeypatch.setattr("lu_voice_loop.speech.SOUND_PATIENCE_SECS", 1.0)
    model = WordsOnlyTTS()
    tts = SharedPocketTTSService(tts_model=model, voice_state=object(), voice="alba")
    down, up = await run_test(
        tts, frames_to_send=[TTSSpeakFrame("Hello there."), TTSSpeakFrame("..."), TTSSpeakFrame("And on it goes."), SleepFrame(2.5)],
    )
    assert model.asked == ["Hello there.", "And on it goes."]
    assert len([f for f in down if isinstance(f, TTSAudioRawFrame)]) >= 2
    assert not [f for f in [*down, *up] if isinstance(f, ErrorFrame)], [f.error for f in [*down, *up] if isinstance(f, ErrorFrame)]
