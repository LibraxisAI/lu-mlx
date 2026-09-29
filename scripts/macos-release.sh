#!/usr/bin/env bash
# LU macOS release pipeline (Tauri 2):
#   sidecar check → tauri build (.app / .dmg) → optional notarytool + staple
#   → operator copies under release/macos/ (NOT repo-root dist/).
#
# WHY not dist/: tauri.conf.json frontendDist is ../dist (Vite). See
# scripts/lib/macos-app.sh.
#
# Credentials are NEVER committed. Resolution order is documented in
# `make print-env` / `make help`:
#   Signing:  APPLE_SIGNING_IDENTITY → LU_SIGNING_IDENTITY →
#             ~/.keys/signing-identity.txt
#   Notary:   APPLE_API_KEY+ISSUER+KEY_PATH → APPLE_ID+PASSWORD+TEAM_ID →
#             ~/.keys/.notary.env (NOTARY_APPLE_ID / NOTARY_TEAM_ID / NOTARY_PASSWORD)
#
# tauri.conf.json keeps bundle.macOS.signingIdentity="-" so Linux/Windows CI
# and `scripts/ci-tauri-build.sh` stay keyless. This script exports Apple env
# only for the local macOS operator lanes.
#
# Updater minisign (TAURI_SIGNING_PRIVATE_KEY) is a different key from Apple
# notarization. The overlay src-tauri/tauri.release.conf.json is passed only
# when that key is present — the same split as .github/workflows/release.yml
# vs scripts/ci-tauri-build.sh. A missing updater key must not fail a
# Developer ID / notarized DMG that Gatekeeper cares about.
#
# Usage:
#   ./scripts/macos-release.sh                 # signed + notarized .app + .dmg
#   ./scripts/macos-release.sh --no-notarize   # signed .app + .dmg, no notary
#   ./scripts/macos-release.sh --no-notarize --no-dmg
#   ./scripts/macos-release.sh --unsigned      # signingIdentity=- (Gatekeeper warns)
#   ./scripts/macos-release.sh --debug         # tauri build --debug
#   ./scripts/macos-release.sh --clean         # retire previous bundle dir first
#   ./scripts/macos-release.sh --dmg-only      # package + notarize DMG from existing .app
#   ./scripts/macos-release.sh --staple-only   # stapler staple existing .app + .dmg
#   ./scripts/macos-release.sh --print-plan    # preflight + print lane, no build
#   ./scripts/macos-release.sh --preflight     # alias for --print-plan
#   ./scripts/macos-release.sh --print-env     # redacted identity/sidecar dump, no build
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/macos-app.sh
source "$SCRIPT_DIR/lib/macos-app.sh"
# shellcheck source=scripts/lib/build-keychain.sh
source "$SCRIPT_DIR/lib/build-keychain.sh"

DO_NOTARIZE=1
DO_CLEAN=0
DMG_ONLY=0
DO_DMG=1
DO_BUILD=1
UNSIGNED=0
DEBUG=0
PRINT_PLAN=0
PRINT_ENV=0
STAPLE_ONLY=0

for arg in "$@"; do
    case "$arg" in
        --no-notarize) DO_NOTARIZE=0 ;;
        --clean)       DO_CLEAN=1 ;;
        --dmg-only)    DMG_ONLY=1 ;;
        --no-dmg)      DO_DMG=0 ;;
        --unsigned)    UNSIGNED=1 ;;
        --debug)       DEBUG=1 ;;
        --print-plan)  PRINT_PLAN=1 ;;
        --preflight)   PRINT_PLAN=1 ;;
        --print-env)   PRINT_ENV=1 ;;
        --staple-only) STAPLE_ONLY=1 ;;
        -h|--help)
            sed -n '1,40p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) die "Unknown arg: $arg (see --help)" ;;
    esac
done

if (( DMG_ONLY )) && (( ! DO_DMG )); then
    die "Args --dmg-only and --no-dmg are contradictory"
fi
if (( STAPLE_ONLY )) && (( DMG_ONLY )); then
    die "Args --staple-only and --dmg-only are contradictory"
fi
if (( UNSIGNED )); then
    export LU_UNSIGNED=1
    DO_NOTARIZE=0
    LANE_SIGNS_FROM_BUILD_KEYCHAIN=0
else
    LANE_SIGNS_FROM_BUILD_KEYCHAIN=1
fi
if (( DEBUG )); then
    export LU_DEBUG_BUILD=1
fi
if (( STAPLE_ONLY )); then
    DO_BUILD=0
    DO_NOTARIZE=0
    DMG_ONLY=0
fi
if (( DMG_ONLY )); then
    DO_BUILD=0
fi

# --print-env is inspection: it must work without a full macOS/notary preflight
# and must never start tauri build. make print-env and make sidecar-check call it.
if (( PRINT_ENV )); then
    macos_print_env
    exit 0
fi

macos_require_macos

BUNDLE_ROOT="$(macos_tauri_bundle_root)"
OPERATOR_DIR="$(macos_operator_dir)"
VERSION="$(macos_app_version)"
COMMIT_SLUG="$(git -C "$MACOS_REPO_ROOT" rev-parse --short=8 HEAD 2>/dev/null || echo unknown)"
BUILD_LABEL="$VERSION+$COMMIT_SLUG"

TAURI_ARGS=()
if (( DEBUG )); then
    TAURI_ARGS+=(--debug)
fi
# --ci matches scripts/ci-tauri-build.sh: no interactive prompts.
TAURI_ARGS+=(--ci)
# Always ask Tauri for the .app only. DMG comes from create_dmg_from_app below.
# Tauri's bundle_dmg.sh needs bundle.macOS.dmg.background (icons/dmg-background.png)
# when dmg is bundled; its Finder AppleScript step can also fail headless.
TAURI_ARGS+=(--bundles app)
# Updater artifacts only in the lane that actually holds the minisign key.
# Baking createUpdaterArtifacts into tauri.conf.json is the v2.6.7 defect
# ci-tauri-build.sh exists to catch.
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    TAURI_ARGS+=(--config src-tauri/tauri.release.conf.json)
    UPDATER_OVERLAY=yes
else
    UPDATER_OVERLAY=no
fi

print_plan() {
    local id kind mode
    kind="$(macos_sidecar_kind || true)"
    id="$(macos_load_signing_identity 2>/dev/null || echo '(missing)')"
    macos_load_notary_env >/dev/null 2>&1 || true
    mode="$(macos_notary_mode || true)"
    printf '\nLU macOS release plan\n'
    printf '  version:           %s\n' "$BUILD_LABEL"
    printf '  sidecar:           %s (%s)\n' "$(macos_sidecar_path)" "$kind"
    printf '  signing identity:  %s\n' "$id"
    printf '  notarize:          %s (mode=%s)\n' "$( (( DO_NOTARIZE )) && echo yes || echo no )" "$mode"
    printf '  dmg:               %s\n' "$( (( DO_DMG )) && echo yes || echo no )"
    printf '  build:             %s\n' "$( (( DO_BUILD )) && echo 'npm run tauri -- build' || echo skip )"
    printf '  debug:             %s\n' "$( (( DEBUG )) && echo yes || echo no )"
    printf '  unsigned:          %s\n' "$( (( UNSIGNED )) && echo yes || echo no )"
    printf '  updater overlay:   %s\n' "$UPDATER_OVERLAY"
    printf '  tauri args:        %s\n' "${TAURI_ARGS[*]}"
    printf '  bundle root:       %s\n' "$BUNDLE_ROOT"
    printf '  operator dir:      %s\n' "$OPERATOR_DIR"
    printf '  (Vite dist/ is the frontend; it is not used as an .app dest)\n\n'
}

stage_operator_copies() {
    local app dmg dest_app dest_dmg versioned
    mkdir -p "$OPERATOR_DIR"
    app="$(macos_app_bundle)" || die "No .app produced under $BUNDLE_ROOT/macos"
    dest_app="$OPERATOR_DIR/${LU_APP_PRODUCT_NAME}.app"
    rm -rf "$dest_app"
    /usr/bin/ditto "$app" "$dest_app"
    ok "Operator .app: $dest_app"
    if (( DO_DMG )); then
        dmg="$(macos_dmg_file 2>/dev/null || true)"
        [[ -f "$dmg" ]] || dmg="$OPERATOR_DIR/${LU_APP_PRODUCT_NAME}-$BUILD_LABEL.dmg"
        [[ -f "$dmg" ]] || die "No .dmg under $BUNDLE_ROOT/dmg or $OPERATOR_DIR"
        dest_dmg="$OPERATOR_DIR/${LU_APP_PRODUCT_NAME}.dmg"
        versioned="$OPERATOR_DIR/${LU_APP_PRODUCT_NAME}-$BUILD_LABEL.dmg"
        cp -f "$dmg" "$dest_dmg"
        cp -f "$dmg" "$versioned"
        ok "Operator .dmg: $dest_dmg"
        ok "Versioned .dmg: $versioned"
        macos_write_sha256sums "$OPERATOR_DIR" \
            "${LU_APP_PRODUCT_NAME}.dmg" \
            "${LU_APP_PRODUCT_NAME}-$BUILD_LABEL.dmg" \
            || die "Could not write $OPERATOR_DIR/SHA256SUMS.txt"
        ok "SHA256: $OPERATOR_DIR/SHA256SUMS.txt"
        shelf_parent="${LU_INTERNAL_RELEASES:-$LU_INTERNAL_RELEASES_DEFAULT}"
        macos_try_internal_shelf \
            "$shelf_parent" \
            "$dmg" \
            "$VERSION"
    fi
}

staple_artifacts() {
    local app dmg
    app="$(macos_app_bundle)" || die "No .app to staple"
    unlock_build_keychain || true
    log "Stapling $app"
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    if dmg="$(macos_dmg_file 2>/dev/null)"; then
        log "Stapling $dmg"
        xcrun stapler staple "$dmg"
        xcrun stapler validate "$dmg"
    fi
    ok "Stapled"
}

# bundle/dmg/ has lost the .dmg mid-notary-wait; operator release/macos/ does not.
stage_dmg_for_notary() {
    local src staged
    src="$(macos_dmg_file)" || die "No .dmg under $BUNDLE_ROOT/dmg"
    mkdir -p "$OPERATOR_DIR"
    staged="$OPERATOR_DIR/${LU_APP_PRODUCT_NAME}-$BUILD_LABEL.dmg"
    cp -f "$src" "$staged"
    echo "$staged"
}

create_dmg_from_app() {
    local app staging dmg_path backup
    app="$(macos_app_bundle 2>/dev/null || true)"
    backup="$OPERATOR_DIR/.build-staging/${LU_APP_PRODUCT_NAME}.app"
    if [[ ! -d "$app" ]]; then
        # Tauri notarization has been observed to leave bundle/macos/ empty
        # briefly; the ditto snapshot taken right after tauri build is the fallback.
        app="$backup"
    fi
    [[ -d "$app" ]] || die "no .app at $BUNDLE_ROOT/macos or $backup — run make release-local first"
    mkdir -p "$BUNDLE_ROOT/dmg" "$OPERATOR_DIR"
    # Drop stale Tauri bundle_dmg.sh artifacts so macos_dmg_file cannot pick them.
    find "$BUNDLE_ROOT/dmg" -maxdepth 1 -name '*.dmg' -type f -delete 2>/dev/null || true
    dmg_path="$BUNDLE_ROOT/dmg/${LU_APP_PRODUCT_NAME}-$BUILD_LABEL.dmg"
    staging="$(mktemp -d "${TMPDIR:-/tmp}/lu-dmg.XXXXXX")"
    # WHY Applications symlink: a drag-install DMG without it is just a folder
    # of bits; Gatekeeper users expect the drop target.
    /usr/bin/ditto "$app" "$staging/${LU_APP_PRODUCT_NAME}.app"
    ln -s /Applications "$staging/Applications"
    rm -f "$dmg_path"
    hdiutil create \
        -volname "$LU_APP_PRODUCT_NAME" \
        -srcfolder "$staging" \
        -ov \
        -format UDZO \
        "$dmg_path" || die "hdiutil create failed for $dmg_path"
    rm -rf "$staging"
    # /Volumes/* repos can lag between hdiutil returning and the .dmg showing up;
    # codesign then prints "No such file" and the lane dies with exit 1.
    local tries=0
    until [[ -f "$dmg_path" ]] || (( tries++ >= 50 )); do sleep 0.2; done
    [[ -f "$dmg_path" ]] || die "hdiutil finished but $dmg_path never appeared"
    if [[ "${LU_UNSIGNED:-0}" != 1 ]]; then
        local id
        id="$(macos_load_signing_identity)"
        unlock_build_keychain || true
        codesign --force --sign "$id" --timestamp "$dmg_path"
        codesign --verify --verbose=2 "$dmg_path"
    fi
    ok "DMG: $dmg_path"
}

notarize_path() {
    local file="$1"
    local log_file="$2"
    macos_require_notary
    log "Submitting $file to notarytool (may take several minutes)"
    if [[ "$(macos_notary_mode)" == api-key ]]; then
        xcrun notarytool submit "$file" \
            --key "$APPLE_API_KEY_PATH" \
            --key-id "$APPLE_API_KEY" \
            --issuer "$APPLE_API_ISSUER" \
            --wait \
            --timeout 30m 2>&1 | tee "$log_file"
    else
        xcrun notarytool submit "$file" \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "$APPLE_PASSWORD" \
            --wait \
            --timeout 30m 2>&1 | tee "$log_file"
    fi
    if grep -q "status: Accepted" "$log_file"; then
        ok "Notary Accepted: $file"
    else
        die "Notarization was not Accepted for $file — see $log_file"
    fi
}

notarize_app_and_dmg() {
    local app dmg zip
    app="$(macos_app_bundle)" || die "No .app to notarize"
    mkdir -p "$OPERATOR_DIR"
    zip="$OPERATOR_DIR/${LU_APP_PRODUCT_NAME}.app.zip"
    rm -f "$zip"
    /usr/bin/ditto -c -k --keepParent "$app" "$zip"
    notarize_path "$zip" "$OPERATOR_DIR/notary-app.log"
    rm -f "$zip"
    log "Stapling notarization ticket onto .app"
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    if (( DO_DMG )); then
        dmg="$(stage_dmg_for_notary)"
        notarize_path "$dmg" "$OPERATOR_DIR/notary-dmg.log"
        xcrun stapler staple "$dmg"
        xcrun stapler validate "$dmg"
    fi
}

tauri_log_indicates_dmg_failure() {
    local log_file="$1"
    grep -qiE 'bundle_dmg\.sh|Copying background file|background\.png|Could not find background|BackgroundPathError' "$log_file"
}

force_tauri_bundles_app() {
    local -a out=()
    local i=0
    while (( i < ${#TAURI_ARGS[@]} )); do
        local arg="${TAURI_ARGS[i]}"
        if [[ "$arg" == --bundles ]]; then
            out+=(--bundles app)
            (( i += 2 ))
            continue
        fi
        if [[ "$arg" == --bundles=* ]]; then
            out+=(--bundles app)
            (( i += 1 ))
            continue
        fi
        out+=("$arg")
        (( i += 1 ))
    done
    if ! printf '%s\n' "${out[@]}" | grep -q '^--bundles'; then
        out+=(--bundles app)
    fi
    TAURI_ARGS=("${out[@]}")
}

run_tauri_build() {
    local log_file code
    mkdir -p "$OPERATOR_DIR"
    log_file="$OPERATOR_DIR/tauri-build.log"
    log "npm run tauri -- build ${TAURI_ARGS[*]}"
    set +e
    (
        cd "$MACOS_REPO_ROOT"
        # Identity is public certificate name; password never lands here.
        if [[ "${LU_UNSIGNED:-0}" != 1 ]]; then
            export APPLE_SIGNING_IDENTITY
            APPLE_SIGNING_IDENTITY="$(macos_load_signing_identity)"
        else
            export APPLE_SIGNING_IDENTITY="-"
        fi
        if (( DO_NOTARIZE )); then
            macos_load_notary_env || true
        else
            # Tauri notarizes automatically when APPLE_ID is set. Unset so
            # --no-notarize is a real skip, not "whatever leaked in from the shell".
            unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
            unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
            unset NOTARY_APPLE_ID NOTARY_PASSWORD NOTARY_TEAM_ID
        fi
        unlock_build_keychain || true
        npm run tauri -- build "${TAURI_ARGS[@]}"
    ) 2>&1 | tee "$log_file"
    code="${PIPESTATUS[0]:-1}"
    set -e
    if [[ "$code" -ne 0 ]] && tauri_log_indicates_dmg_failure "$log_file"; then
        warn "Tauri bundle_dmg.sh failed — retrying with --bundles app; DMG will use hdiutil fallback"
        force_tauri_bundles_app
        log "npm run tauri -- build ${TAURI_ARGS[*]}"
        set +e
        (
            cd "$MACOS_REPO_ROOT"
            if [[ "${LU_UNSIGNED:-0}" != 1 ]]; then
                export APPLE_SIGNING_IDENTITY
                APPLE_SIGNING_IDENTITY="$(macos_load_signing_identity)"
            else
                export APPLE_SIGNING_IDENTITY="-"
            fi
            if (( DO_NOTARIZE )); then
                macos_load_notary_env || true
            else
                unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
                unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
                unset NOTARY_APPLE_ID NOTARY_PASSWORD NOTARY_TEAM_ID
            fi
            unlock_build_keychain || true
            npm run tauri -- build "${TAURI_ARGS[@]}"
        ) 2>&1 | tee -a "$log_file"
        code="${PIPESTATUS[0]:-1}"
        set -e
    fi
    [[ "$code" -eq 0 ]] || die "tauri build exited $code — log: $log_file"
    ok "tauri build finished"
}

# ─── Preflight ────────────────────────────────────────────────────────────
macos_require_sidecar
if [[ "${LU_UNSIGNED:-0}" != 1 ]]; then
    macos_require_signing_identity
    preflight_build_keychain
else
    ok "Skipping Developer ID preflight (--unsigned)"
fi
if (( DO_NOTARIZE )); then
    macos_require_notary
fi

print_plan
if (( PRINT_PLAN )); then
    ok "Print-plan only; no build"
    exit 0
fi

if (( STAPLE_ONLY )); then
    staple_artifacts
    stage_operator_copies
    exit 0
fi

if (( DO_CLEAN )) && (( DO_BUILD )); then
    log "Retiring $BUNDLE_ROOT (rename-aside so a live rustc cannot race rm -rf)"
    if [[ -e "$BUNDLE_ROOT" ]]; then
        trash="$BUNDLE_ROOT.trash.$$"
        mv "$BUNDLE_ROOT" "$trash" 2>/dev/null || trash="$BUNDLE_ROOT"
        chmod -R u+w "$trash" 2>/dev/null || true
        rm -rf "$trash" 2>/dev/null || true
    fi
fi

if (( DO_BUILD )); then
    run_tauri_build
    app="$(macos_app_bundle 2>/dev/null || true)"
    [[ -d "$app" ]] || die "tauri build produced no .app under $BUNDLE_ROOT/macos"
    mkdir -p "$OPERATOR_DIR/.build-staging"
    backup="$OPERATOR_DIR/.build-staging/${LU_APP_PRODUCT_NAME}.app"
    rm -rf "$backup"
    /usr/bin/ditto "$app" "$backup"
    ok "Build-staging .app: $backup"
    if (( DO_DMG )); then
        create_dmg_from_app
        stage_dmg_for_notary >/dev/null
        ok "Staged DMG for notary: $OPERATOR_DIR/${LU_APP_PRODUCT_NAME}-$BUILD_LABEL.dmg"
    fi
    # Tauri 2 notarizes during `tauri build` when APPLE_* are set. If the
    # produced .app still has no staple ticket, run the explicit notarytool
    # path so a future CLI that skips notarization cannot silently ship.
    if (( DO_NOTARIZE )); then
        app="$(macos_app_bundle)" || die "tauri build produced no .app"
        if ! xcrun stapler validate "$app" >/dev/null 2>&1; then
            warn "Tauri build did not leave a stapled ticket — running notarytool ourselves"
            notarize_app_and_dmg
        else
            ok "Tauri already stapled $app"
            if (( DO_DMG )); then
                dmg="$(stage_dmg_for_notary)"
                if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
                    warn "DMG has no staple ticket — notarizing DMG"
                    notarize_path "$dmg" "$OPERATOR_DIR/notary-dmg.log"
                    [[ -f "$dmg" ]] || die "DMG vanished after notary submit: $dmg"
                    xcrun stapler staple "$dmg"
                    xcrun stapler validate "$dmg"
                fi
            fi
        fi
    fi
fi

if (( DMG_ONLY )); then
    create_dmg_from_app
    stage_dmg_for_notary >/dev/null
    if (( DO_NOTARIZE )); then
        notarize_app_and_dmg
    fi
fi

stage_operator_copies

echo ""
echo "  App: $(macos_app_bundle 2>/dev/null || echo missing)"
if (( DO_DMG )); then
    echo "  DMG: $(macos_dmg_file 2>/dev/null || echo missing)"
    echo "  Stable alias: $OPERATOR_DIR/${LU_APP_PRODUCT_NAME}.dmg"
    echo "  SHA256: $OPERATOR_DIR/SHA256SUMS.txt"
fi
echo "  Open:  open '$(macos_app_bundle 2>/dev/null || true)'"
echo "  Fresh install: make install-built-app"
echo ""
ok "macOS release lane complete"
