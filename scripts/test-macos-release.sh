#!/usr/bin/env bash
# Unit tests for scripts/lib/macos-app.sh — sidecar stub refusal, identity
# loading, and print-env redaction. Never touches the real llama-server or
# ~/.keys files; fixtures live under $TMPDIR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/macos-app.sh
source "$SCRIPT_DIR/lib/macos-app.sh"

FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/lu-macos-release-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

PASS=0
FAIL=0
pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '\033[31m[FAIL]\033[0m %s\n       %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); }

# ── sidecar kinds ─────────────────────────────────────────────────────────
export LU_SIDECAR_PATH="$FIXTURE/lu-llama-server-test"
rm -f "$LU_SIDECAR_PATH"
kind="$(macos_sidecar_kind || true)"
[[ "$kind" == missing ]] && pass "sidecar missing" || fail "sidecar missing" "kind=$kind"

: > "$LU_SIDECAR_PATH"
kind="$(macos_sidecar_kind || true)"
[[ "$kind" == stub ]] && pass "sidecar empty stub" || fail "sidecar stub" "kind=$kind"

printf 'not-empty' > "$LU_SIDECAR_PATH"
kind="$(macos_sidecar_kind || true)"
[[ "$kind" == ok ]] && pass "sidecar real (non-empty)" || fail "sidecar ok" "kind=$kind"

if (macos_require_sidecar >/dev/null); then
    pass "require_sidecar accepts non-empty"
else
    fail "require_sidecar accepts non-empty" "exited $?"
fi

: > "$LU_SIDECAR_PATH"
if (macos_require_sidecar >/dev/null 2>"$FIXTURE/stub.err"); then
    fail "require_sidecar refuses stub" "should have died"
else
    if grep -q "empty CI stub" "$FIXTURE/stub.err"; then
        pass "require_sidecar names the CI stub"
    else
        fail "require_sidecar names the CI stub" "$(cat "$FIXTURE/stub.err")"
    fi
fi

# ── identity ──────────────────────────────────────────────────────────────
export LU_KEYS_DIR="$FIXTURE/keys"
mkdir -p "$LU_KEYS_DIR"
unset APPLE_SIGNING_IDENTITY LU_SIGNING_IDENTITY LU_UNSIGNED
export LU_SIGNING_IDENTITY_FILE="$LU_KEYS_DIR/signing-identity.txt"
if macos_load_signing_identity >/dev/null 2>&1; then
    fail "identity missing fails" "unexpected success"
else
    pass "identity missing fails closed"
fi

printf '  Developer ID Application: Test Fixture (ABCD1234) \n' > "$LU_SIGNING_IDENTITY_FILE"
got="$(macos_load_signing_identity)"
[[ "$got" == "Developer ID Application: Test Fixture (ABCD1234)" ]] \
    && pass "identity file trimmed" \
    || fail "identity file trimmed" "got='$got'"

export APPLE_SIGNING_IDENTITY='Apple Development: Env Wins (EEEE0000)'
got="$(macos_load_signing_identity)"
[[ "$got" == "Apple Development: Env Wins (EEEE0000)" ]] \
    && pass "APPLE_SIGNING_IDENTITY wins over file" \
    || fail "APPLE_SIGNING_IDENTITY wins" "got='$got'"
unset APPLE_SIGNING_IDENTITY

export LU_UNSIGNED=1
got="$(macos_load_signing_identity)"
[[ "$got" == "-" ]] && pass "unsigned lane identity=-" || fail "unsigned lane" "got='$got'"
unset LU_UNSIGNED

# ── print-env redaction ───────────────────────────────────────────────────
export NOTARY_PASSWORD='supersecret-notary-password'
export APPLE_PASSWORD='supersecret-apple-password'
export TAURI_SIGNING_PRIVATE_KEY='supersecret-minisign'
macos_print_env > "$FIXTURE/env.txt"
if grep -q 'supersecret' "$FIXTURE/env.txt"; then
    fail "print-env redacts secrets" "leaked: $(grep supersecret "$FIXTURE/env.txt")"
else
    pass "print-env redacts secrets"
fi
if grep -q 'TAURI_SIGNING_PRIVATE_KEY (updater minisign): set' "$FIXTURE/env.txt"; then
    pass "print-env reports updater key as set"
else
    fail "print-env reports updater key as set" "$(cat "$FIXTURE/env.txt")"
fi
unset NOTARY_PASSWORD APPLE_PASSWORD TAURI_SIGNING_PRIVATE_KEY

# ── version is semver-like from package.json ──────────────────────────────
ver="$(macos_app_version)"
[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] && pass "app version from package.json ($ver)" \
    || fail "app version" "got='$ver'"

# ── internal shelf parent defaults to iCloud _RELEASES, not the volume ──
expected_shelf="$HOME/Library/Mobile Documents/com~apple~CloudDocs/_RELEASES"
if [[ "$LU_INTERNAL_RELEASES_DEFAULT" == "$expected_shelf" ]]; then
    pass "internal shelf default is iCloud _RELEASES"
else
    fail "internal shelf default is iCloud _RELEASES" "got='$LU_INTERNAL_RELEASES_DEFAULT'"
fi
rel="$MACOS_REPO_ROOT/scripts/macos-release.sh"
# A volume path next to _RELEASES means the shelf was hardcoded to one
# machine. The comment in macos-release.sh may still say /Volumes/* as a
# class of disks; that is not an assignment.
if grep -E '/Volumes/.*/_RELEASES' "$rel"; then
    fail "release lane must not use volume _RELEASES" "found a /Volumes shelf parent"
elif grep -q 'LU_INTERNAL_RELEASES:-\$LU_INTERNAL_RELEASES_DEFAULT' "$rel"; then
    pass "release lane shelves via LU_INTERNAL_RELEASES override"
else
    fail "release lane shelves via LU_INTERNAL_RELEASES override" "call site missing"
fi

# ── internal shelf is optional: write failure must not fail the release ──
dummy_dmg="$FIXTURE/LU.dmg"
printf 'not-a-real-dmg\n' > "$dummy_dmg"
writable="$FIXTURE/shelf-ok"
mkdir -p "$writable"
shelf_out="$(macos_try_internal_shelf "$writable" "$dummy_dmg" "9.9.9" 2>&1)"
shelf_st=$?
if [[ "$shelf_st" -eq 0 && -f "$writable/LU/9.9.9/LU.dmg" && -s "$writable/LU/9.9.9/SHA256SUMS.txt" && "$shelf_out" == *"Internal shelf:"* ]]; then
    pass "internal shelf writes when permitted"
else
    fail "internal shelf writes when permitted" "status=$shelf_st out=$shelf_out"
fi

blocked="$FIXTURE/shelf-blocked"
mkdir -p "$blocked"
printf 'cannot-mkdir-through-a-file\n' > "$blocked/LU"
set +e
blocked_out="$(macos_try_internal_shelf "$blocked" "$dummy_dmg" "9.9.9" 2>&1)"
blocked_st=$?
set -e
if [[ "$blocked_st" -eq 0 && "$blocked_out" == *"Internal shelf skipped"* && ! -d "$blocked/LU" ]]; then
    pass "internal shelf skip is non-fatal"
else
    fail "internal shelf skip is non-fatal" "status=$blocked_st out=$blocked_out"
fi

missing_shelf="$FIXTURE/shelf-missing"
set +e
missing_out="$(macos_try_internal_shelf "$missing_shelf" "$dummy_dmg" "9.9.9" 2>&1)"
missing_st=$?
set -e
if [[ "$missing_st" -eq 0 && -z "$missing_out" && ! -e "$missing_shelf" ]]; then
    pass "internal shelf no-ops when parent is absent"
else
    fail "internal shelf no-ops when parent is absent" "status=$missing_st out=$missing_out"
fi

# ── operator dir gets SHA256SUMS.txt next to the versioned DMG ───────────
op="$FIXTURE/operator"
mkdir -p "$op"
printf 'versioned-dmg-bytes\n' > "$op/LU-9.9.9+abcdef12.dmg"
cp "$op/LU-9.9.9+abcdef12.dmg" "$op/LU.dmg"
if macos_write_sha256sums "$op" LU.dmg "LU-9.9.9+abcdef12.dmg"; then
    expected="$(shasum -a 256 "$op/LU-9.9.9+abcdef12.dmg" | awk '{print $1}')"
    if [[ -s "$op/SHA256SUMS.txt" ]] && grep -F -q "${expected}  LU-9.9.9+abcdef12.dmg" "$op/SHA256SUMS.txt" \
        && (cd "$op" && shasum -a 256 -c SHA256SUMS.txt >/dev/null); then
        pass "operator SHA256SUMS.txt matches the versioned dmg"
    else
        fail "operator SHA256SUMS.txt matches the versioned dmg" "$(cat "$op/SHA256SUMS.txt" 2>&1)"
    fi
else
    fail "operator SHA256SUMS.txt matches the versioned dmg" "macos_write_sha256sums exited $?"
fi
set +e
macos_write_sha256sums "$op" "missing.dmg" >/dev/null 2>&1
missing_sha=$?
set -e
if [[ "$missing_sha" -ne 0 ]]; then
    pass "missing dmg fails SHA256SUMS write"
else
    fail "missing dmg fails SHA256SUMS write" "exited 0"
fi

# ── never cd src-tauri in Makefile recipes ────────────────────────────────
mk="$MACOS_REPO_ROOT/Makefile"
if grep -E '^[[:space:]]*@?cd \$\(SRC_TAURI\)' "$mk"; then
    fail "Makefile must not cd SRC_TAURI" "found a recipe that cds into the crate"
else
    pass "Makefile cargo/tauri recipes stay at repo root"
fi

# ── loct assert refuses src-tauri cwd (does not run loct there) ───────────
set +e
refuse_out="$(cd "$MACOS_REPO_ROOT/src-tauri" && "$MACOS_REPO_ROOT/scripts/assert-loct-repo-root.sh" 2>&1)"
refuse_st=$?
set -e
if [[ "$refuse_st" -ne 0 && "$refuse_out" == *src-tauri* && "$refuse_out" == *"cd $MACOS_REPO_ROOT"* ]]; then
    pass "assert-loct-repo-root refuses src-tauri cwd"
else
    fail "assert-loct-repo-root refuses src-tauri cwd" "status=$refuse_st out=$refuse_out"
fi

if [[ -f "$MACOS_REPO_ROOT/src-tauri/.loctree" && ! -d "$MACOS_REPO_ROOT/src-tauri/.loctree" ]]; then
    pass "src-tauri/.loctree is a sentinel file"
else
    fail "src-tauri/.loctree is a sentinel file" "$(ls -ld "$MACOS_REPO_ROOT/src-tauri/.loctree" 2>&1)"
fi

# PATH shim must refuse *before* a fake loct can mkdir .loctree or write a
# crate-keyed cache. The sentinel file alone does not stop loct scan.
shim="$MACOS_REPO_ROOT/scripts/bin"
fake_bin="$FIXTURE/fake-loct-bin"
mkdir -p "$fake_bin"
fake_marker="$FIXTURE/fake-loct-ran"
cat > "$fake_bin/loct" <<EOF
#!/bin/sh
printf 'fake-loct-ran\n' > "$fake_marker"
mkdir -p .loctree
exit 0
EOF
chmod +x "$fake_bin/loct"
rm -f "$fake_marker"
set +e
shim_out="$(cd "$MACOS_REPO_ROOT/src-tauri" && PATH="$shim:$fake_bin:$PATH" loct scan 2>&1)"
shim_st=$?
set -e
if [[ "$shim_st" -ne 0 && ! -e "$fake_marker" && -f "$MACOS_REPO_ROOT/src-tauri/.loctree" && ! -d "$MACOS_REPO_ROOT/src-tauri/.loctree" && "$shim_out" == *src-tauri* ]]; then
    pass "scripts/bin/loct refuses crate cwd before any scan"
else
    fail "scripts/bin/loct refuses crate cwd before any scan" "status=$shim_st marker=$(ls -l "$fake_marker" 2>&1) out=$shim_out"
fi

rm -f "$fake_marker"
set +e
( cd "$MACOS_REPO_ROOT" && PATH="$shim:$fake_bin:$PATH" loct --help >/dev/null 2>&1 )
allow_st=$?
set -e
if [[ "$allow_st" -eq 0 && -f "$fake_marker" ]]; then
    pass "scripts/bin/loct allows repo root"
else
    fail "scripts/bin/loct allows repo root" "status=$allow_st marker=$(ls -l "$fake_marker" 2>&1)"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
