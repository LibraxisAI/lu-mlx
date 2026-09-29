#!/usr/bin/env bash
# Refuse to run loctree from src-tauri/ (or any path that is not the git root).
#
# WHY: `loct scan` keys the snapshot cache on canonical_root. An accidental
# `cd src-tauri && loct` creates a second project identity whose map is the
# Rust crate alone. The sentinel FILE `src-tauri/.loctree` only blocks mkdir
# of a nested `.loctree/` directory — it does NOT stop the global cache
# bucket (`~/Library/Caches/loctree/projects/<crate-id>/`). Call this
# script *before* exec'ing loct (see scripts/bin/loct). Always invoke loct
# from the repository root.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    printf 'loct: not inside a git checkout\n' >&2
    exit 1
}
cwd="$(pwd -P)"
root_p="$(cd "$root" && pwd -P)"

print_root_remedium() {
    printf '      Run from the repo root `.` (not src-tauri):\n' >&2
    printf '        cd %s\n' "$root_p" >&2
    printf '        loct …\n' >&2
    printf '        npm run tauri:dev\n' >&2
    printf '        npm run tauri:build\n' >&2
    printf '        npx --package=@tauri-apps/cli tauri --help\n' >&2
    printf '        make loc\n' >&2
}

# Walk toward the git root so `cd src-tauri/src && loct` is the same refuse
# as `cd src-tauri && loct` (clearer than the generic non-root message).
crate=""
cur="$cwd"
while true; do
    if [[ "$(basename "$cur")" == "src-tauri" ]]; then
        crate="$cur"
        break
    fi
    [[ "$cur" == "/" || "$cur" == "$root_p" ]] && break
    parent="$(dirname "$cur")"
    [[ "$parent" == "$cur" ]] && break
    cur="$parent"
done

if [[ -n "$crate" ]]; then
    printf 'loct: refuse to run from src-tauri/ (cwd=%s).\n' "$cwd" >&2
    printf '      Accidental nested snapshots are not a LU project map.\n' >&2
    printf '      The sentinel FILE src-tauri/.loctree blocks a nested .loctree dir,\n' >&2
    printf '      but loct scan still writes a crate-keyed cache bucket.\n' >&2
    print_root_remedium
    exit 1
fi

if [[ "$cwd" != "$root_p" ]]; then
    printf 'loct: cwd is %s — run from the repo root %s\n' "$cwd" "$root_p" >&2
    print_root_remedium
    exit 1
fi
