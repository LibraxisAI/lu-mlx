#!/usr/bin/env bash
# Hermetic install-transaction tests: never inspect/stop a real LU process or
# touch /Applications/LU.app.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/install-built-app.sh
source "$SCRIPT_DIR/install-built-app.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/lu-install-test.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

write_fake_app() {
    local root="$1"
    mkdir -p "$root/Contents/MacOS"
    printf 'payload' > "$root/Contents/MacOS/LU"
    cat > "$root/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.purpledoubled.locally-uncensored</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-test</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
PLIST
    touch "$root/trusted"
}

lu_install_verify_signature() { [[ -f "$1/trusted" ]]; }
lu_install_copy() { /bin/cp -R "$1" "$2"; }
lu_install_assert_idle() {
    idle_calls=$((idle_calls + 1))
    [[ "$busy_call" != "$idle_calls" ]]
}

setup_case() {
    case_root="$fixture/$1"
    mkdir -p "$case_root/apps"
    write_fake_app "$case_root/source.app"
    write_fake_app "$case_root/apps/LU.app"
    printf old > "$case_root/apps/LU.app/Contents/MacOS/LU"
    printf new > "$case_root/source.app/Contents/MacOS/LU"
    idle_calls=0
    busy_call=0
}
assert_old() { [[ "$(cat "$case_root/apps/LU.app/Contents/MacOS/LU")" == old ]]; }
reject_install() {
    if lu_install_built_app "$case_root/source.app" "$case_root/apps/LU.app"; then
        printf 'FAIL: unsafe installation unexpectedly succeeded\n' >&2
        exit 1
    fi
    assert_old
    [[ ! -e "$case_root/apps/.lu-install-lock" ]]
}

setup_case initially_busy
busy_call=1
reject_install

setup_case becomes_busy_during_copy
busy_call=2
reject_install

setup_case wrong_bundle_id
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.example.stranger' \
    "$case_root/source.app/Contents/Info.plist"
# restore verify_signature override still in place; identity check should fire first
reject_install

setup_case copy_failure
lu_install_copy() { return 1; }
reject_install
lu_install_copy() { /bin/cp -R "$1" "$2"; }

setup_case rejected_installed_payload
lu_install_verify_signature() { return 1; }
reject_install
lu_install_verify_signature() { [[ -f "$1/trusted" ]]; }

setup_case successful_swap
lu_install_built_app "$case_root/source.app" "$case_root/apps/LU.app"
[[ "$(cat "$case_root/apps/LU.app/Contents/MacOS/LU")" == new ]]
[[ ! -e "$case_root/apps/.lu-install-lock" ]]
backup="$(find "$case_root/apps" -path '*/previous/LU.app/Contents/MacOS/LU')"
[[ "$(cat "$backup")" == old ]]

printf 'install-built-app tests passed\n'
