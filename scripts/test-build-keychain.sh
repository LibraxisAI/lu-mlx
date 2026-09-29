#!/usr/bin/env bash
# Unit tests for scripts/lib/build-keychain.sh.
#
# NOTHING here touches a real keychain. `security` and `launchctl` are replaced
# by PATH shims — `security show-keychain-info` against a LOCKED keychain
# raises a SecurityAgent panel and blocks, which is exactly the hang this
# preflight exists to prevent, so the suite must not reproduce it.
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
KEYCHAIN_LIB="$SCRIPT_DIR/lib/build-keychain.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/lu-build-keychain.XXXXXX")"
SHIM_DIR="$FIXTURE/bin"
CALL_LOG="$FIXTURE/calls.log"
KEYCHAIN="$FIXTURE/lu-build.keychain-db"
PASSWORD_FILE="$FIXTURE/.build-keychain-pw"

PASS=0
FAIL=0
pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '\033[31m[FAIL]\033[0m %s\n       %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); }

trap 'rm -rf "$FIXTURE"' EXIT

grep -q '>>> build-keychain preflight' "$KEYCHAIN_LIB" \
    && pass "open fence marker present" \
    || fail "open fence marker" "missing in $KEYCHAIN_LIB"
grep -q '<<< build-keychain preflight <<<' "$KEYCHAIN_LIB" \
    && pass "close fence marker present" \
    || fail "close fence marker" "missing"

mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/security" <<'SH'
#!/bin/sh
echo "$*" >> "$CALL_LOG"
case "$1" in
  show-keychain-info)
    [ "${SHIM_LOCKED:-0}" = 1 ] && exit 1
    exit 0
    ;;
  unlock-keychain)
    if [ "$2" = "-p" ]; then
      [ "$3" = "$TEST_PASSWORD" ] || exit 1
      exit 0
    fi
    exit 1
    ;;
  *) exit 0 ;;
esac
SH
cat > "$SHIM_DIR/launchctl" <<'SH'
#!/bin/sh
if [ "$1" = managername ]; then
  printf '%s\n' "${SHIM_LAUNCHCTL:-Aqua}"
  exit 0
fi
exit 0
SH
chmod +x "$SHIM_DIR/security" "$SHIM_DIR/launchctl"

export PATH="$SHIM_DIR:$PATH"
export CALL_LOG
export TEST_PASSWORD='s3cr3t-pw'
export LU_BUILD_KEYCHAIN="$KEYCHAIN"
export LU_BUILD_KEYCHAIN_PASSWORD_FILE="$PASSWORD_FILE"
export KEYS_DIR="$FIXTURE"

ok() { :; }
warn() { printf 'WARN %s\n' "$*"; }
die() { printf 'DIE %s\n' "$*" >&2; exit 42; }

# shellcheck source=scripts/lib/build-keychain.sh
source "$KEYCHAIN_LIB"

# Absent keychain → unlock is a no-op (login-keychain identities still work).
rm -f "$KEYCHAIN"
status=0
unlock_build_keychain || status=$?
[[ "$status" -eq 0 ]] && pass "unlock no-ops when keychain file is absent" \
    || fail "absent keychain" "status $status"

# Wider than 0600 is refused (status 3) rather than read.
touch "$KEYCHAIN"
printf '%s\n' "$TEST_PASSWORD" > "$PASSWORD_FILE"
chmod 644 "$PASSWORD_FILE"
status=0
unlock_build_keychain || status=$?
[[ "$status" -eq 3 ]] && pass "world-readable password file returns 3" \
    || fail "mode 644" "status=$status"
# Confirm we never handed -p to security in this case.
if grep -q 'unlock-keychain' "$CALL_LOG" 2>/dev/null; then
    fail "mode 644 must not call unlock-keychain" "$(cat "$CALL_LOG")"
else
    pass "mode 644 does not call security unlock-keychain"
fi

chmod 600 "$PASSWORD_FILE"
: > "$CALL_LOG"
status=0
unlock_build_keychain || status=$?
[[ "$status" -eq 0 ]] && pass "0600 password unlocks via -p" \
    || fail "0600 unlock" "status=$status"
if grep -q "unlock-keychain -p $TEST_PASSWORD" "$CALL_LOG"; then
    pass "unlock used non-interactive -p"
else
    fail "unlock used -p" "$(cat "$CALL_LOG")"
fi

# SSH + locked keychain must die, never call show-keychain-info from a
# promptable path. preflight_build_keychain in a non-Aqua session:
export SSH_CONNECTION='1.2.3.4 22'
export SHIM_LAUNCHCTL='Background'
export SHIM_LOCKED=1
rm -f "$PASSWORD_FILE"
set +e
out="$(preflight_build_keychain 2>&1)"
status=$?
set -e
unset SSH_CONNECTION
[[ "$status" -eq 42 ]] && pass "SSH + locked keychain dies closed" \
    || fail "SSH locked die" "status=$status out=$out"
[[ "$out" == *errSecInternalComponent* ]] && pass "error names errSecInternalComponent" \
    || fail "error names the codesign trap" "out=$out"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
