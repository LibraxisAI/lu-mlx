#!/usr/bin/env bash
# Install an existing LU .app into /Applications without interrupting a live
# session. Sourceable so the transaction can be tested inside a fixture root
# (see scripts/test-install-built-app.sh) — those tests never touch the real
# /Applications/LU.app.
#
# WHY the idle check: replacing a running bundle on macOS can leave the old
# Mach-O mapped and the new files half-written. The install lane refuses to
# quit the app for you. Quit LU yourself after saving.

LU_INSTALL_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

lu_install_error() {
    printf 'install: %s\n' "$*" >&2
}

lu_install_assert_idle() {
    local pids
    # Two names: tauri productName is LU; cargo package is locally-uncensored.
    # `pgrep; pgrep` cannot be used as the if-condition — the last status would
    # hide a running LU when the second name is idle.
    pids="$(
        { /usr/bin/pgrep -x LU || true; /usr/bin/pgrep -x locally-uncensored || true; } \
            | awk 'NF'
    )"
    if [[ -n "$pids" ]]; then
        lu_install_error "LU is running (PID: ${pids//$'\n'/, }). Quit it yourself after saving, then retry. No process was stopped."
        return 1
    fi
}

lu_install_bundle_id() {
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null
}

lu_install_verify() {
    local bundle="$1" got expected
    expected="${LU_APP_BUNDLE_ID:-com.purpledoubled.locally-uncensored}"
    [[ -d "$bundle/Contents/MacOS" ]] || {
        lu_install_error "not an application bundle: $bundle"
        return 1
    }
    got="$(lu_install_bundle_id "$bundle")" || {
        lu_install_error "no CFBundleIdentifier in $bundle"
        return 1
    }
    [[ "$got" == "$expected" ]] || {
        lu_install_error "bundle id '$got' != '$expected' — refusing to install a stranger over LU"
        return 1
    }
}

lu_install_verify_signature() {
    # Ad-hoc / unsigned local builds (signingIdentity=-) still have a signature
    # object; --strict is what we want for Developer ID. Fall back to a warning
    # only when LU_ALLOW_UNSIGNED_INSTALL=1.
    if /usr/bin/codesign --verify --deep --strict "$1" >/dev/null 2>&1; then
        return 0
    fi
    if [[ "${LU_ALLOW_UNSIGNED_INSTALL:-0}" == 1 || "${LU_INSTALL_ALLOW_ADHOC:-0}" == 1 ]]; then
        printf 'install: signature is not strict-valid; unsigned install override is set so continuing\n' >&2
        return 0
    fi
    lu_install_error "codesign --verify --deep --strict failed for $1
       Signed local install: make release-local && make install-built-app
       Unsigned override:    LU_ALLOW_UNSIGNED_INSTALL=1 make install-built-app"
    return 1
}

lu_install_copy() {
    /usr/bin/ditto "$1" "$2"
}

lu_install_compare() {
    /usr/bin/diff -qr "$1" "$2"
}

lu_install_receipt() {
    local bundle="$1" key
    printf 'installed_bundle: %s\n' "$bundle"
    for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion; do
        printf '%s: ' "$key"
        /usr/libexec/PlistBuddy -c "Print :$key" "$bundle/Contents/Info.plist" || return 1
    done
}

lu_install_built_app() (
    local source_bundle="$1" destination="$2" parent capsule had_previous=false
    parent="$(dirname "$destination")"
    [[ "$destination" == "$parent/${LU_APP_PRODUCT_NAME:-LU}.app" && -d "$parent" && ! -L "$parent" \
        && ! -L "$destination" && ! -L "$source_bundle" && -d "$source_bundle" \
        && "$source_bundle" != "$destination" ]] || {
        lu_install_error "source/destination must be distinct physical app directories named ${LU_APP_PRODUCT_NAME:-LU}.app"
        return 1
    }
    [[ ! -e "$destination" || -d "$destination" ]] || {
        lu_install_error "destination is not an application directory"
        return 1
    }
    local lock_directory="$parent/.lu-install-lock"
    /bin/mkdir "$lock_directory" 2>/dev/null || {
        lu_install_error "another install owns $lock_directory; no bundle was changed"
        return 1
    }
    trap '/bin/rmdir "$lock_directory"' EXIT
    lu_install_assert_idle || return 1
    lu_install_verify "$source_bundle" || return 1
    capsule="$(/usr/bin/mktemp -d "$parent/.lu-install.XXXXXX")" || return 1
    printf 'install_transaction: %s\n' "$capsule"
    lu_install_copy "$source_bundle" "$capsule/${LU_APP_PRODUCT_NAME:-LU}.app" || return 1
    lu_install_verify "$capsule/${LU_APP_PRODUCT_NAME:-LU}.app" || return 1
    lu_install_compare "$source_bundle" "$capsule/${LU_APP_PRODUCT_NAME:-LU}.app" || return 1
    lu_install_assert_idle || return 1
    if [[ -e "$destination" ]]; then
        /bin/mkdir "$capsule/previous" || return 1
        /bin/mv "$destination" "$capsule/previous/${LU_APP_PRODUCT_NAME:-LU}.app" || return 1
        had_previous=true
    fi
    if ! /bin/mv "$capsule/${LU_APP_PRODUCT_NAME:-LU}.app" "$destination"; then
        if [[ "$had_previous" == true ]]; then
            /bin/mv "$capsule/previous/${LU_APP_PRODUCT_NAME:-LU}.app" "$destination" || return 1
        fi
        return 1
    fi
    if ! lu_install_verify_signature "$destination" \
        || ! lu_install_compare "$source_bundle" "$destination"; then
        lu_install_error "installed verification failed; candidate and previous bundle retained at $capsule"
        if lu_install_assert_idle; then
            /bin/mv "$destination" "$capsule/Failed-LU.app" || return 1
            if [[ "$had_previous" == true ]]; then
                /bin/mv "$capsule/previous/${LU_APP_PRODUCT_NAME:-LU}.app" "$destination" || return 1
            fi
        fi
        return 1
    fi
    lu_install_receipt "$destination" || return 1
    if [[ "$had_previous" == true ]]; then
        printf 'previous_bundle: %s/previous/%s.app\n' "$capsule" "${LU_APP_PRODUCT_NAME:-LU}"
    else
        /bin/rmdir "$capsule" || return 1
    fi
    printf 'install: verified; ready for an intentional production-profile launch\n'
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    set -euo pipefail
    # shellcheck source=scripts/lib/macos-app.sh
    source "$LU_INSTALL_SCRIPT_DIR/lib/macos-app.sh"
    macos_require_macos
    if [[ "${1:-}" == --check-idle && $# == 1 ]]; then
        lu_install_assert_idle
        exit $?
    fi
    [[ $# -le 1 ]] || { lu_install_error 'usage: install-built-app.sh [source.app]'; exit 2; }
    default_source=""
    if default_source="$(macos_app_bundle 2>/dev/null)"; then
        true
    else
        default_source="$MACOS_REPO_ROOT/release/macos/${LU_APP_PRODUCT_NAME}.app"
    fi
    lu_install_built_app \
        "${1:-$default_source}" \
        "${LU_INSTALL_DEST:-/Applications/${LU_APP_PRODUCT_NAME}.app}"
fi
