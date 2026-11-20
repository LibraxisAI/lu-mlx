"""More than one voice: which ones LU offers, which are installed, how one is heard.

The manifest lists every voice. The app installs the chosen one and fetches
another when the user picks it, so the sidecar has to start with any one of
them on disk, load a voice that arrived while it was running, and let the
settings play a sample without a session.
"""

import io
import json
import wave
from pathlib import Path

import httpx
import pytest
from conftest import FakeTTS, FakeWhisper

from lu_voice_loop.engines import Engines
from lu_voice_loop.errors import FatalStartupError
from lu_voice_loop.log import pipeline_error_line, safe_error_text, safe_text
from lu_voice_loop.models import MANIFEST_PATH, check_installed, installed_voices, load_manifest, voices
from lu_voice_loop.server import SAMPLE_TEXT

# Licenses that allow commercial use. Anything else does not belong in the list.
ALLOWED_LICENSES = {"CC-BY-4.0", "CC0-1.0"}
# What the model card names for each voice LU offers (kyutai/tts-voices).
ALLOWED_ORIGINS = ("alba-mackenna/", "vctk/", "voice-donations/")
PINNED = "e041936c75475d350b405bc870bcf7c22da4e9e6"


def raw_voices() -> list[dict]:
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return [m for m in raw["models"] if m["role"] == "tts-voice"]


def hollow(models_dir: Path, names: set[str] | None = None) -> None:
    """Base models and the named voices at their exact size, empty inside."""
    for entry in load_manifest().values():
        if entry.role == "tts-voice" and names is not None and entry.id[len("tts-voice-"):] not in names:
            continue
        for f in entry.files:
            target = models_dir / f.path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as handle:
                handle.truncate(f.size)


def test_alba_is_still_there_and_there_are_more():
    names = list(voices(load_manifest()))
    assert names[0] == "alba"
    assert len(names) >= 2
    assert len(set(names)) == len(names)


def test_every_voice_has_a_license_that_allows_commercial_use_and_says_where_it_is_from():
    for voice in raw_voices():
        assert voice["license"] in ALLOWED_LICENSES, voice["id"]
        assert voice["origin"].startswith("https://huggingface.co/kyutai/tts-voices/blob/main/"), voice["id"]
        assert voice["origin"].split("/blob/main/")[1].startswith(ALLOWED_ORIGINS), voice["id"]
        credit = voice["attribution"]
        assert '"%s"' % voice["name"] in credit and credit.endswith("."), voice["id"]
        # The sets the model card marks as non-commercial never get in.
        assert "expresso" not in voice["origin"] and "ears/" not in voice["origin"], voice["id"]


def test_every_voice_is_one_pinned_file_in_the_folder_of_the_speech_model():
    for voice in raw_voices():
        assert voice["id"] == "tts-voice-" + voice["name"]
        assert voice["revision"] == PINNED
        (only,) = voice["files"]
        assert only["path"] == "tts/pocket-tts-english/%s.safetensors" % voice["name"]
        assert only["url"].endswith("/resolve/%s/languages/english/embeddings/%s.safetensors" % (PINNED, voice["name"]))
        assert len(only["sha256"]) == 64 and only["size"] > 1_000_000


def test_no_text_of_the_manifest_carries_a_long_dash():
    text = MANIFEST_PATH.read_text(encoding="utf-8")
    assert "\u2014" not in text and "\u2013" not in text


def test_one_installed_voice_is_enough_to_start(tmp_path):
    hollow(tmp_path, {"anna"})
    manifest = load_manifest()
    check_installed(tmp_path, manifest)
    assert list(installed_voices(tmp_path, manifest)) == ["anna"]


def test_without_any_voice_the_start_is_refused_with_a_sentence(tmp_path):
    hollow(tmp_path, set())
    with pytest.raises(FatalStartupError) as refused:
        check_installed(tmp_path, load_manifest())
    assert refused.value.code == "model_missing"
    assert refused.value.message == "No voice is installed. Install the voice models again."


def test_a_voice_that_is_cut_short_does_not_count_as_installed(tmp_path):
    hollow(tmp_path, {"alba", "anna"})
    manifest = load_manifest()
    with (tmp_path / voices(manifest)["anna"].path).open("r+b") as handle:
        handle.truncate(100)
    assert list(installed_voices(tmp_path, manifest)) == ["alba"]
    check_installed(tmp_path, manifest)


class CountingTTS(FakeTTS):
    def __init__(self):
        self.loaded: list[str] = []

    def get_state_for_audio_prompt(self, path: str):
        self.loaded.append(Path(path).stem)
        return {"voice": Path(path).stem}


def engines_with(tmp_path, installed: set[str]) -> Engines:
    hollow(tmp_path, installed)
    return Engines(
        whisper=FakeWhisper(), tts=CountingTTS(), voice_states={"alba": object()},
        models_dir=tmp_path, voice_files=voices(load_manifest()),
    )


def test_a_voice_installed_while_the_engine_runs_is_loaded_when_it_is_asked_for(tmp_path):
    engines = engines_with(tmp_path, {"alba"})
    assert engines.has_voice("alba") and not engines.has_voice("anna")
    with pytest.raises(KeyError):
        engines.voice_state("anna")

    hollow(tmp_path, {"anna"})
    assert engines.has_voice("anna")
    assert engines.voice_state("anna") == {"voice": "anna"}
    # Loaded once, then kept.
    engines.voice_state("anna")
    assert engines.tts.loaded == ["anna"]


def test_a_name_that_is_not_in_the_list_is_never_a_voice(tmp_path):
    engines = engines_with(tmp_path, {"alba"})
    (tmp_path / "tts/pocket-tts-english/stranger.safetensors").write_bytes(b"x")
    assert not engines.has_voice("stranger")
    assert not engines.has_voice("../alba")


# ---- the sample -----------------------------------------------------------


async def post_sample(harness, body, **header_args) -> httpx.Response:
    async with httpx.AsyncClient() as http:
        if isinstance(body, bytes):
            return await http.post(harness.base + "/sample", content=body, headers=harness.headers(**header_args))
        return await http.post(harness.base + "/sample", json=body, headers=harness.headers(**header_args))


async def test_the_sample_is_a_wav_file_of_the_fixed_sentence(harness):
    spoken = []
    stock = harness.voice.engines.tts.generate_audio_stream

    def record(state, text, copy_state=True):
        spoken.append(text)
        return stock(state, text, copy_state=copy_state)

    harness.voice.engines.tts.generate_audio_stream = record
    response = await post_sample(harness, {"voice": "alba"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(response.content), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 24000)
        assert wav.getnframes() == 3 * 1920
    assert spoken == [SAMPLE_TEXT]


async def test_the_sample_needs_the_launch_token_and_an_allowed_origin(harness):
    assert (await post_sample(harness, {"voice": "alba"}, token="wrong")).status_code == 401
    assert (await post_sample(harness, {"voice": "alba"}, origin="https://example.org")).status_code == 403


async def test_the_sample_takes_a_voice_name_and_nothing_to_say(harness):
    assert (await post_sample(harness, {"voice": "nobody"})).json()["error"] == "The voice nobody is not installed."
    assert (await post_sample(harness, {"voice": "../alba"})).status_code == 422
    assert (await post_sample(harness, {"text": "say this"})).status_code == 422
    assert (await post_sample(harness, b"{not json")).status_code == 400
    assert (await post_sample(harness, b"[]")).status_code == 400


async def test_no_sample_while_a_session_is_running(harness):
    async with harness.session():
        response = await post_sample(harness, {"voice": "alba"})
        assert response.status_code == 409
        assert response.json()["error"] == "A voice session is running. Stop it to listen to a voice."


async def test_a_session_can_use_a_voice_that_was_installed_after_the_start(harness, tmp_path):
    engines = harness.voice.engines
    engines.tts = CountingTTS()
    engines.models_dir = tmp_path
    engines.voice_files = voices(load_manifest())
    hollow(tmp_path, {"anna"})
    async with harness.session(harness.config(voice="anna")):
        assert engines.tts.loaded == ["anna"]


# ---- what an error may say in the log --------------------------------------


def test_an_error_keeps_its_reason_and_loses_what_it_quotes():
    assert safe_error_text(RuntimeError("shape mismatch at layer 3")) == "RuntimeError: shape mismatch at layer 3"
    assert safe_error_text(KeyError("anna")) == "KeyError: 'anna'"
    assert safe_error_text(ValueError()) == "ValueError"
    quoted = safe_error_text(ValueError('bad request: "%s"' % ("the user said something private " * 3)))
    assert quoted == "ValueError: bad request: [redacted]"
    key = safe_error_text(RuntimeError("rejected sk-" + "a1B2" * 12))
    assert "a1B2a1B2" not in key and key.endswith("[redacted]")


def test_an_error_is_one_short_line():
    text = safe_text("first line\nsecond line   with   gaps " + "word " * 200)
    assert "\n" not in text and "  " not in text
    assert len(text) <= 304 and text.endswith(" ...")


def test_an_operating_system_error_keeps_its_number_and_not_its_sentence():
    assert safe_error_text(FileNotFoundError(2, "Das System kann die Datei nicht finden")) == "FileNotFoundError (os error 2)"


def test_a_pipeline_error_names_where_it_happened_and_what_it_said():
    class Frame:
        error = "Speech synthesis failed (RuntimeError)."
        fatal = False
        processor = FakeTTS()

    assert pipeline_error_line(Frame()) == "Pipeline error in FakeTTS: Speech synthesis failed (RuntimeError)."
    Frame.fatal, Frame.processor, Frame.error = True, None, ""
    assert pipeline_error_line(Frame()) == "Pipeline error in the pipeline (fatal): no text"


def test_the_fake_voice_is_silent():
    # Guards the frame count the sample test relies on.
    assert sum(chunk.numel() for chunk in FakeTTS().generate_audio_stream(None, "x")) == 3 * 1920
