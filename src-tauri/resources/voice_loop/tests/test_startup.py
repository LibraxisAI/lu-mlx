"""Process lifecycle: clear startup errors, clean exit, nothing left behind."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from lu_voice_loop.models import load_manifest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
REAL_MODELS = os.environ.get("LU_VOICE_MODELS_DIR")
TOKEN = "startup-test-token-" + "y" * 32


def run(args: list[str], env: dict | None = None, stdin=subprocess.DEVNULL, timeout: float = 60.0) -> subprocess.CompletedProcess:
    base = {k: v for k, v in os.environ.items() if not k.startswith("LU_VOICE_")}
    return subprocess.run(
        [sys.executable, "-m", "lu_voice_loop", *args], cwd=PACKAGE_ROOT, env=base | (env or {}),
        stdin=stdin, capture_output=True, text=True, timeout=timeout,
    )


def spawn(args: list[str], env: dict | None = None) -> subprocess.Popen:
    base = {k: v for k, v in os.environ.items() if not k.startswith("LU_VOICE_")}
    return subprocess.Popen(
        [sys.executable, "-m", "lu_voice_loop", *args], cwd=PACKAGE_ROOT, env=base | (env or {}),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


def events(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines() if line.startswith("{")]


def read_event(process: subprocess.Popen, name: str, timeout: float = 120.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if not line:
            break
        if line.startswith("{") and json.loads(line)["event"] in (name, "fatal"):
            return json.loads(line)
    raise AssertionError("no %s event" % name)


@pytest.fixture
def hollow_models(tmp_path) -> Path:
    """Every manifest file at its exact size, but empty inside. Sparse, so instant."""
    for entry in load_manifest().values():
        for f in entry.files:
            target = tmp_path / f.path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as handle:
                handle.truncate(f.size)
    return tmp_path


def test_token_must_come_from_the_environment(hollow_models):
    result = run(["--port", "0", "--models-dir", str(hollow_models)])
    assert result.returncode == 2
    fatal = events(result.stdout)[-1]
    assert fatal["event"] == "fatal" and fatal["code"] == "bad_environment"
    assert "LU_VOICE_TOKEN" in fatal["message"]
    # There is no way to pass it as an argument.
    assert run(["--port", "0", "--models-dir", str(hollow_models), "--token", TOKEN]).returncode == 2


def test_missing_model_is_named(tmp_path):
    result = run(["--port", "0", "--models-dir", str(tmp_path)], env={"LU_VOICE_TOKEN": TOKEN})
    assert result.returncode == 3
    fatal = events(result.stdout)[-1]
    assert fatal["code"] == "model_missing"
    assert fatal["message"].startswith("Voice model file is missing: stt/faster-whisper-base.en/")
    assert fatal["message"] in result.stderr


def test_incomplete_model_is_named(hollow_models):
    victim = hollow_models / "tts/pocket-tts-english/model.safetensors"
    with victim.open("r+b") as handle:
        handle.truncate(1000)
    result = run(["--port", "0", "--models-dir", str(hollow_models)], env={"LU_VOICE_TOKEN": TOKEN})
    assert result.returncode == 3
    fatal = events(result.stdout)[-1]
    assert fatal["code"] == "model_incomplete" and "tts/pocket-tts-english/model.safetensors" in fatal["message"]


def test_busy_port_is_reported_at_once(hollow_models):
    with socket.socket() as holder:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        port = holder.getsockname()[1]
        result = run(["--port", str(port), "--models-dir", str(hollow_models)], env={"LU_VOICE_TOKEN": TOKEN})
    assert result.returncode == 4
    fatal = events(result.stdout)[-1]
    assert fatal["code"] == "port_in_use"
    assert fatal["message"] == "Port %d on 127.0.0.1 is already in use. Close the other program or restart the app." % port


def test_verify_models_catches_a_bad_checksum(hollow_models):
    result = run(["--port", "0", "--models-dir", str(hollow_models), "--verify-models"])
    assert result.returncode == 3
    assert events(result.stdout)[-1]["code"] == "model_corrupt"


def test_unloadable_model_ends_the_process_with_a_message(hollow_models):
    process = spawn(["--port", "0", "--models-dir", str(hollow_models)], env={"LU_VOICE_TOKEN": TOKEN})
    try:
        assert read_event(process, "listening")["event"] == "listening"
        fatal = read_event(process, "ready")
        assert fatal["event"] == "fatal" and fatal["code"] == "model_load_failed"
        assert fatal["message"].startswith("The voice models could not be loaded: ")
        # Stdin is still open: the process ends because of the failure.
        assert process.wait(timeout=12) == 5
    finally:
        process.kill()


def test_stdin_close_ends_the_process(hollow_models):
    process = spawn(["--port", "0", "--models-dir", str(hollow_models)], env={"LU_VOICE_TOKEN": TOKEN})
    try:
        assert read_event(process, "listening")["event"] == "listening"
        process.stdin.close()
        # Exits on its own, well inside the hard exit window.
        process.wait(timeout=12)
    finally:
        process.kill()


def test_binds_loopback_only(hollow_models):
    process = spawn(["--port", "0", "--models-dir", str(hollow_models)], env={"LU_VOICE_TOKEN": TOKEN})
    try:
        port = read_event(process, "listening")["port"]
        with socket.socket() as probe:
            probe.settimeout(2)
            assert probe.connect_ex(("127.0.0.1", port)) == 0
        lan_ip = _lan_ip()
        if lan_ip:
            with socket.socket() as probe:
                probe.settimeout(2)
                assert probe.connect_ex((lan_ip, port)) != 0
    finally:
        process.kill()


def _lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            ip = s.getsockname()[0]
            return None if ip.startswith("127.") else ip
    except OSError:
        return None


# ---- with the real models ------------------------------------------------------

needs_models = pytest.mark.skipif(not REAL_MODELS, reason="set LU_VOICE_MODELS_DIR to the installed voice models")


@needs_models
@pytest.mark.models
def test_real_models_pass_the_checksum():
    result = run(["--port", "0", "--models-dir", REAL_MODELS, "--verify-models"], timeout=120)
    assert result.returncode == 0 and events(result.stdout)[-1]["event"] == "verified"


@needs_models
@pytest.mark.models
@pytest.mark.parametrize("how", ["sigterm", "stdin"])
def test_real_start_becomes_ready_and_stops_cleanly(how):
    process = spawn(["--port", "0", "--models-dir", REAL_MODELS], env={"LU_VOICE_TOKEN": TOKEN})
    try:
        port = read_event(process, "listening")["port"]
        assert read_event(process, "ready")["event"] == "ready"
        health = httpx.get("http://127.0.0.1:%d/health" % port).json()
        assert health["state"] == "ready"
        if how == "sigterm":
            process.send_signal(signal.SIGTERM)
        else:
            process.stdin.close()
        assert process.wait(timeout=12) == 0
        # The port is free again.
        with socket.socket() as probe:
            probe.settimeout(1)
            assert probe.connect_ex(("127.0.0.1", port)) != 0
    finally:
        process.kill()
