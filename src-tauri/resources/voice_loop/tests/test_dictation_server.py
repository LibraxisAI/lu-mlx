"""Dictation in the chat can run on the Python of the Voice feature.

That Python has faster-whisper, but its file decoder (PyAV) does not take the
call faster-whisper makes. The dictation server (resources/whisper_server.py)
reads the WAV that dictation records by itself when the decoder fails.
"""

import importlib.util
import os
import wave

import numpy as np
import pytest

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "whisper_server.py")
spec = importlib.util.spec_from_file_location("whisper_server", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def write_wav(path, samples: np.ndarray, rate: int, channels: int = 1, width: int = 2):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(samples.tobytes())


def tone(rate: int, secs: float) -> np.ndarray:
    t = np.arange(int(rate * secs)) / rate
    return (np.sin(2 * np.pi * 220 * t) * 16000).astype("<i2")


def test_a_16_khz_take_is_handed_over_sample_for_sample(tmp_path):
    take = tone(16000, 0.5)
    write_wav(tmp_path / "take.wav", take, 16000)
    samples = server.wav_samples(str(tmp_path / "take.wav"))
    assert samples.dtype == np.float32 and len(samples) == len(take)
    assert np.allclose(samples, take.astype(np.float32) / 32768.0)


def test_a_take_from_an_8_khz_headset_is_brought_to_16_khz(tmp_path):
    write_wav(tmp_path / "take.wav", tone(8000, 1.0), 8000)
    samples = server.wav_samples(str(tmp_path / "take.wav"))
    assert len(samples) == 16000
    # Still the same tone: about 220 crossings from below per second.
    crossings = int(np.sum((samples[:-1] < 0) & (samples[1:] >= 0)))
    assert 215 <= crossings <= 225


def test_two_channels_become_one(tmp_path):
    left = tone(16000, 0.25)
    stereo = np.stack([left, np.zeros_like(left)], axis=1).reshape(-1)
    write_wav(tmp_path / "take.wav", stereo, 16000, channels=2)
    samples = server.wav_samples(str(tmp_path / "take.wav"))
    assert len(samples) == len(left)
    assert np.allclose(samples, left.astype(np.float32) / 32768.0 / 2, atol=1e-4)


def test_anything_else_is_not_read_here(tmp_path):
    (tmp_path / "take.webm").write_bytes(b"\x1a\x45\xdf\xa3 not a wav")
    assert server.wav_samples(str(tmp_path / "take.webm")) is None
    write_wav(tmp_path / "bytes.wav", (tone(16000, 0.1) >> 8).astype(np.uint8), 16000, width=1)
    assert server.wav_samples(str(tmp_path / "bytes.wav")) is None
    assert server.wav_samples(str(tmp_path / "missing.wav")) is None


class Segment:
    def __init__(self, text):
        self.text = text


class Info:
    language = "en"


class ModelWhoseDecoderFails:
    """faster-whisper 1.2.1 on PyAV 19: every file path ends in this TypeError."""

    def __init__(self):
        self.got = []

    def transcribe(self, audio):
        self.got.append(audio)
        if isinstance(audio, str):
            raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
        return [Segment(" Hello"), Segment(" there.")], Info()


class ModelWhoseDecoderWorks:
    def __init__(self):
        self.got = []

    def transcribe(self, audio):
        self.got.append(audio)
        return [Segment(" Fine.")], Info()


def test_a_take_is_transcribed_from_its_samples_when_the_decoder_fails(tmp_path):
    write_wav(tmp_path / "take.wav", tone(16000, 0.3), 16000)
    model = ModelWhoseDecoderFails()
    assert server.transcribe_file(model, str(tmp_path / "take.wav")) == ("Hello  there.", "en")
    assert isinstance(model.got[0], str) and isinstance(model.got[1], np.ndarray)


def test_a_working_decoder_is_used_as_before(tmp_path):
    write_wav(tmp_path / "take.wav", tone(16000, 0.3), 16000)
    model = ModelWhoseDecoderWorks()
    assert server.transcribe_file(model, str(tmp_path / "take.wav")) == ("Fine.", "en")
    assert model.got == [str(tmp_path / "take.wav")]


def test_a_file_that_is_no_wav_keeps_the_error_of_the_decoder(tmp_path):
    (tmp_path / "take.webm").write_bytes(b"not audio")
    with pytest.raises(TypeError):
        server.transcribe_file(ModelWhoseDecoderFails(), str(tmp_path / "take.webm"))


class Av19:
    """PyAV 19: open() no longer takes metadata_errors."""

    def __init__(self):
        self.calls = []

    def open(self, file, mode="r", format=None, options=None):
        self.calls.append((file, mode))
        return "container"


class Av18:
    """PyAV up to 18: open() takes metadata_errors and honours it."""

    def __init__(self):
        self.calls = []

    def open(self, file, mode="r", metadata_errors="strict"):
        self.calls.append((file, mode, metadata_errors))
        return "container"


def test_the_call_of_faster_whisper_opens_a_file_on_pyav_19():
    av = Av19()
    with pytest.raises(TypeError, match="metadata_errors"):
        av.open("take.m4a", mode="r", metadata_errors="ignore")
    server.keep_decoder_call_working(av)
    assert av.open("take.m4a", mode="r", metadata_errors="ignore") == "container"
    assert av.calls == [("take.m4a", "r")]


def test_an_older_pyav_still_gets_the_argument():
    av = Av18()
    server.keep_decoder_call_working(av)
    assert av.open("take.m4a", mode="r", metadata_errors="ignore") == "container"
    assert av.calls == [("take.m4a", "r", "ignore")]


def test_any_other_type_error_of_the_decoder_is_passed_on():
    av = Av19()
    server.keep_decoder_call_working(av)
    with pytest.raises(TypeError, match="no_such_option"):
        av.open("take.m4a", no_such_option=1)
    with pytest.raises(TypeError, match="no_such_option"):
        av.open("take.m4a", metadata_errors="ignore", no_such_option=1)


def test_the_copy_the_dev_build_runs_is_the_same_file():
    # commands/whisper.rs falls back to public/whisper_server.py in a dev run.
    dev_copy = os.path.join(os.path.dirname(SERVER), "..", "..", "public", "whisper_server.py")
    with open(SERVER, "rb") as bundled, open(dev_copy, "rb") as dev:
        assert bundled.read() == dev.read()
