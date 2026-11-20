#!/usr/bin/env bash
#
# mac-engine-pins-dry-run.sh: can pip still resolve what the four Mac media
# engines install on a customer's Mac?
#
# The engines are not in the .app. LU builds a venv per engine on the
# customer's Mac and runs `pip install --upgrade <pins>` there, so a release
# that was yanked, or a wheel that does not exist for Apple Silicon, is found
# by the customer. This script asks pip the same question first.
#
# Two questions per engine, both with `--dry-run`: pip resolves and reads the
# metadata, nothing is installed.
#
#   1. Does the whole list resolve on this Mac, exactly as the app passes it
#      (`pip install --upgrade <pins>`)?
#   2. Do the `name==version` pins and everything they pull in exist as
#      wheels for the OLDEST macOS LU supports (--platform macosx_<min>_arm64,
#      wheels only)? The runner is newer than that, so question 1 alone would
#      accept a wheel a Mac on the minimum system cannot install. The two
#      engines that come as a source archive from GitHub are left out of this
#      second pass: pip cannot build a source archive for another platform.
#
# The lists come from scripts/mac-engine-pins.mjs, which reads them from the
# Rust constants and the requirements file the app uses. Nothing is listed
# here.
#
# One fresh venv in a work directory holds pip. It is never one of the app's
# own venvs under ~/Library/Application Support/lu-labs.
#
# Usage:
#   scripts/mac-engine-pins-dry-run.sh                       # python3 from the PATH
#   PYTHON=/path/to/python3.12 scripts/mac-engine-pins-dry-run.sh
#   WORK_DIR=/some/empty/dir scripts/mac-engine-pins-dry-run.sh
#   MIN_MACOS=14.0 scripts/mac-engine-pins-dry-run.sh        # default: tauri.macos.conf.json
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

log() { printf '%s\n' "$*" >&2; }

PYTHON="${PYTHON:-python3}"
WORK_DIR="${WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/lu-engine-pins.XXXXXX")}"

# The oldest macOS, from the one place the bundle reads it.
MIN_MACOS="${MIN_MACOS:-$(node -e '
  const conf = require(process.argv[1])
  const v = conf.bundle && conf.bundle.macOS && conf.bundle.macOS.minimumSystemVersion
  if (!v) { console.error("tauri.macos.conf.json names no minimumSystemVersion"); process.exit(1) }
  process.stdout.write(v)
' "$ROOT/src-tauri/tauri.macos.conf.json")}" || exit 1
[ -n "$MIN_MACOS" ] || { log "FAIL: could not read the minimum macOS version"; exit 1; }
PLATFORM_TAG="macosx_${MIN_MACOS//./_}_arm64"

# The app runs the engines on its own Python. Resolving on another line would
# answer for wheels the customer never asks for.
want_python="$(node "$HERE/mac-engine-pins.mjs" --python)" || exit 1
have_python="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" \
  || { log "FAIL: '$PYTHON' does not run. Set PYTHON to a Python $want_python."; exit 1; }
if [ "$have_python" != "$want_python" ]; then
  log "FAIL: '$PYTHON' is Python $have_python, the app's own Python is $want_python (python.json)."
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  log "FAIL: this check answers for Apple Silicon and has to run on one ($(uname -s) $(uname -m))."
  exit 1
fi

mkdir -p "$WORK_DIR/pins"
venv="$WORK_DIR/venv"
rm -rf "$venv"
"$PYTHON" -m venv "$venv" || { log "FAIL: could not create a venv in $WORK_DIR"; exit 1; }
pip=("$venv/bin/python" -m pip --disable-pip-version-check --no-input)
log "pip: $("${pip[@]}" --version)"
log "work directory: $WORK_DIR, minimum macOS: $MIN_MACOS ($PLATFORM_TAG)"

engines="$(node "$HERE/mac-engine-pins.mjs" --write "$WORK_DIR/pins")" || exit 1

failed=0
for engine in $engines; do
  list="$WORK_DIR/pins/$engine.txt"
  log ""
  log "== $engine: the whole list, as the app installs it"
  sed 's/^/   /' "$list" >&2
  if "${pip[@]}" install --dry-run --upgrade -r "$list" >"$WORK_DIR/$engine.host.log" 2>&1; then
    grep -E '^Would install' "$WORK_DIR/$engine.host.log" >&2 || log "   (pip named nothing to install)"
    log "OK: $engine resolves on this Mac."
  else
    tail -n 30 "$WORK_DIR/$engine.host.log" >&2
    log "FAIL: $engine does not resolve. A customer who installs this engine today gets this error."
    failed=$((failed + 1))
    continue
  fi

  exact="$WORK_DIR/pins/$engine.exact.txt"
  grep -v ' @ ' "$list" >"$exact"
  if [ ! -s "$exact" ]; then
    log "FAIL: $engine has no name==version pin at all; the second pass would check nothing."
    failed=$((failed + 1))
    continue
  fi
  log "== $engine: wheels for macOS $MIN_MACOS on Apple Silicon"
  if "${pip[@]}" install --dry-run --upgrade --only-binary=:all: \
       --platform "$PLATFORM_TAG" --python-version "$want_python" --implementation cp \
       -r "$exact" >"$WORK_DIR/$engine.min.log" 2>&1; then
    log "OK: every pinned package of $engine and what it pulls in has a wheel for macOS $MIN_MACOS."
  else
    tail -n 30 "$WORK_DIR/$engine.min.log" >&2
    log "FAIL: $engine needs a package that has no wheel for macOS $MIN_MACOS on Apple Silicon."
    failed=$((failed + 1))
  fi
done

log ""
if [ "$failed" -ne 0 ]; then
  log "FAIL: $failed check(s) failed. Logs: $WORK_DIR"
  exit 1
fi
log "OK: all four engines resolve, and their pins have wheels for macOS $MIN_MACOS."
