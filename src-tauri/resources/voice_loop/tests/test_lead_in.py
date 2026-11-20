"""The first words of somebody who speaks into an answer are part of the utterance.

Speech that is quiet is detected late. What was said before detection is in
the lead-in the recognizer keeps, and the utterance begins where the sound
does, not one second before detection.
"""

import inspect

import numpy as np
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import InputAudioRawFrame, VADUserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.stt_service import SegmentedSTTService

from lu_voice_loop import pipeline
from lu_voice_loop.speech import (
    LEAD_IN_ALWAYS_SECS,
    LEAD_IN_MARGIN_SECS,
    LEAD_IN_SECS,
    SEGMENT_BUFFER_FIELD,
    SEGMENT_SPEAKING_FIELD,
    SharedWhisperSTTService,
    speech_onset,
)
from conftest import FakeWhisper

RATE = 16000


def silence(secs: float, noise: int = 0) -> np.ndarray:
    count = int(RATE * secs)
    if not noise:
        return np.zeros(count, dtype=np.int16)
    return np.random.default_rng(7).integers(-noise, noise + 1, count).astype(np.int16)


def voice(secs: float, peak: int) -> np.ndarray:
    t = np.arange(int(RATE * secs)) / RATE
    return (np.sin(2 * np.pi * 180 * t) * peak).astype(np.int16)


def onset_secs(*parts: np.ndarray) -> float:
    pcm = np.concatenate(parts).tobytes()
    return speech_onset(pcm, RATE) / 2 / RATE


def test_speech_detected_at_once_keeps_the_last_second():
    # Two seconds of silence, then 0.3 s of voice: the usual case.
    assert abs(onset_secs(silence(2.0), voice(0.3, 8000)) - (2.3 - LEAD_IN_ALWAYS_SECS)) < 1e-6


def test_speech_detected_late_keeps_its_first_words():
    # The voice began 1.6 s before it was detected.
    start = onset_secs(silence(1.4), voice(1.6, 300))
    assert abs(start - (1.4 - LEAD_IN_MARGIN_SECS)) <= 0.03


def test_a_quiet_voice_over_a_noise_floor_is_found_the_same_way():
    start = onset_secs(silence(1.2, noise=12), voice(1.8, 250) + silence(1.8, noise=12))
    assert abs(start - (1.2 - LEAD_IN_MARGIN_SECS)) <= 0.03


def test_a_sentence_before_a_long_pause_is_not_pulled_in():
    # Something was said, then nothing for 0.8 s, then the utterance.
    start = onset_secs(voice(0.5, 3000), silence(0.8), voice(1.5, 3000))
    assert abs(start - (1.3 - LEAD_IN_MARGIN_SECS)) <= 0.03


def test_a_short_pause_inside_the_utterance_does_not_cut_it():
    # "Hold on," then 0.3 s, then the question.
    start = onset_secs(silence(0.6), voice(0.5, 3000), silence(0.3), voice(1.4, 3000))
    assert abs(start - (0.6 - LEAD_IN_MARGIN_SECS)) <= 0.03


def test_sound_all_the_way_keeps_the_whole_lead_in():
    assert onset_secs(voice(3.0, 3000)) == 0.0


def test_less_audio_than_the_kept_second_is_kept_whole():
    assert onset_secs(voice(0.4, 3000)) == 0.0
    assert speech_onset(b"", RATE) == 0


async def started(stt: SharedWhisperSTTService, *parts: np.ndarray) -> float:
    """Feed audio in microphone sized frames, then the detection. Seconds kept."""
    stt._sample_rate = RATE
    stt._lead_in_bytes = int(RATE * LEAD_IN_SECS) * 2
    pcm = np.concatenate(parts).tobytes()
    for at in range(0, len(pcm), 1024):
        await stt.process_audio_frame(InputAudioRawFrame(pcm[at:at + 1024], RATE, 1), FrameDirection.DOWNSTREAM)
    await stt._handle_user_started_speaking(VADUserStartedSpeakingFrame())
    return len(getattr(stt, SEGMENT_BUFFER_FIELD)) / 2 / RATE


async def test_the_recognizer_keeps_three_seconds_and_cuts_them_to_the_utterance():
    stt = SharedWhisperSTTService(whisper_model=FakeWhisper())
    # Ten seconds of silence do not pile up.
    assert abs(await started(stt, silence(10.0)) - LEAD_IN_ALWAYS_SECS) < 1e-6
    stt = SharedWhisperSTTService(whisper_model=FakeWhisper())
    kept = await started(stt, silence(6.0), voice(1.6, 300))
    assert abs(kept - (1.6 + LEAD_IN_MARGIN_SECS)) <= 0.03
    assert getattr(stt, SEGMENT_SPEAKING_FIELD) is True


async def test_audio_keeps_growing_while_the_user_speaks():
    stt = SharedWhisperSTTService(whisper_model=FakeWhisper())
    kept = await started(stt, silence(2.0), voice(0.3, 8000))
    pcm = voice(5.0, 8000).tobytes()
    await stt.process_audio_frame(InputAudioRawFrame(pcm, RATE, 1), FrameDirection.DOWNSTREAM)
    assert abs(len(getattr(stt, SEGMENT_BUFFER_FIELD)) / 2 / RATE - (kept + 5.0)) < 1e-6


def test_pipecat_still_has_the_fields_the_lead_in_works_on():
    source = inspect.getsource(SegmentedSTTService)
    assert "self.%s = bytearray()" % SEGMENT_BUFFER_FIELD in source
    assert "self.%s = False" % SEGMENT_SPEAKING_FIELD in source
    assert "async def _handle_user_started_speaking" in source
    assert "async def process_audio_frame" in source


def test_a_voice_turned_down_by_the_echo_cancellation_still_counts_as_speech():
    # Pipecat's scale: 0 is -110 LUFS, 1 is -10 LUFS. Its default is 0.6.
    assert pipeline.VAD_MIN_VOLUME == 0.5
    assert pipeline.VAD_MIN_VOLUME < VADParams().min_volume
