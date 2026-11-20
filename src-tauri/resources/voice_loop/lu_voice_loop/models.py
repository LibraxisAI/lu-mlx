"""The model manifest and the check that every file is installed.

models.json is the single list of what the app has to download. The app
verifies sha256 after each download; at start this module only checks presence
and size, which is instant. `--verify-models` hashes everything.

The manifest lists every voice LU offers. The app installs the one the user
chose and fetches another when it is picked, so a voice that is not on disk is
not an error. At least one has to be there.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .errors import EXIT_MODEL_MISSING, EXIT_USAGE, FatalStartupError

MANIFEST_PATH = Path(__file__).resolve().parent.parent / "models.json"

STT_ID = "stt-faster-whisper-base-en"
TTS_ID = "tts-pocket-tts-english"
VOICE_PREFIX = "tts-voice-"
VOICE_ROLE = "tts-voice"


@dataclass(frozen=True)
class ModelFile:
    path: str
    url: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ModelEntry:
    id: str
    role: str
    license: str
    dir: str
    files: tuple[ModelFile, ...]


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, ModelEntry]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        entries = {}
        for m in raw["models"]:
            files = tuple(ModelFile(f["path"], f["url"], int(f["size"]), f["sha256"]) for f in m["files"])
            entries[m["id"]] = ModelEntry(m["id"], m["role"], m["license"], m["dir"], files)
        return entries
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise FatalStartupError(
            EXIT_USAGE, "manifest_invalid", "The voice model manifest could not be read (%s)." % type(e).__name__
        ) from e


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_installed(models_dir: Path, f: ModelFile) -> bool:
    """The file is there in full. A download in progress lives under another name."""
    target = models_dir / f.path
    try:
        return target.is_file() and target.stat().st_size == f.size
    except OSError:
        return False


def check_installed(models_dir: Path, manifest: dict[str, ModelEntry], verify_hashes: bool = False) -> None:
    """Raise a FatalStartupError naming the first file that is missing or wrong."""
    have_voices = installed_voices(models_dir, manifest)
    for entry in manifest.values():
        if entry.role == VOICE_ROLE and entry.id[len(VOICE_PREFIX):] not in have_voices:
            continue
        for f in entry.files:
            target = models_dir / f.path
            if not target.is_file():
                raise FatalStartupError(
                    EXIT_MODEL_MISSING, "model_missing",
                    "Voice model file is missing: %s. Install the voice models again." % f.path,
                )
            if target.stat().st_size != f.size:
                raise FatalStartupError(
                    EXIT_MODEL_MISSING, "model_incomplete",
                    "Voice model file is incomplete: %s. Install the voice models again." % f.path,
                )
            if verify_hashes and _sha256(target) != f.sha256:
                raise FatalStartupError(
                    EXIT_MODEL_MISSING, "model_corrupt",
                    "Voice model file failed its checksum: %s. Install the voice models again." % f.path,
                )
    if not have_voices and any(entry.role == VOICE_ROLE for entry in manifest.values()):
        raise FatalStartupError(
            EXIT_MODEL_MISSING, "model_missing",
            "No voice is installed. Install the voice models again.",
        )


def voices(manifest: dict[str, ModelEntry]) -> dict[str, ModelFile]:
    """Voice name to its voice state file, for every voice LU offers."""
    return {
        entry.id[len(VOICE_PREFIX):]: entry.files[0]
        for entry in manifest.values()
        if entry.role == VOICE_ROLE
    }


def installed_voices(models_dir: Path, manifest: dict[str, ModelEntry]) -> dict[str, Path]:
    """Voice name to the path of its state file, for the voices that are on disk."""
    return {
        name: models_dir / f.path
        for name, f in voices(manifest).items()
        if _is_installed(models_dir, f)
    }
