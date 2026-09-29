#!/usr/bin/env bash
# shellcheck shell=bash
# Shared helpers for LU macOS install-app + notarized DMG lanes (Tauri 2).
#
# WHY artifacts live under release/macos/ and NEVER repo-root dist/:
# src-tauri/tauri.conf.json sets build.frontendDist to ../dist (Vite). An app
# with no Vite bundle could park its .app in dist/; here, mixing those
# two meanings would let `make clean` delete the frontend the next tauri build
# expects, or copy an HTML tree into /Applications.
#
# Sourced, never executed. Callers may predefine log/ok/warn/die.

_MACOS_APP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_REPO_ROOT="$(cd "$_MACOS_APP_LIB_DIR/../.." && pwd)"

LU_APP_PRODUCT_NAME="${LU_APP_PRODUCT_NAME:-LU}"
LU_APP_BUNDLE_ID="${LU_APP_BUNDLE_ID:-com.purpledoubled.locally-uncensored}"
LU_KEYS_DIR="${LU_KEYS_DIR:-${KEYS_DIR:-$HOME/.keys}}"
KEYS_DIR="${KEYS_DIR:-$LU_KEYS_DIR}"
# Operator archive shelf (iCloud Drive `_RELEASES`). Override the parent with
# LU_INTERNAL_RELEASES for tests or another machine. The default contains a
# space ("Mobile Documents") — always quote expansions of this path.
# shellcheck disable=SC2034  # read by macos-release.sh after it sources this lib
LU_INTERNAL_RELEASES_DEFAULT="$HOME/Library/Mobile Documents/com~apple~CloudDocs/_RELEASES"

if ! declare -F die >/dev/null 2>&1; then
    log()  { printf '\033[36m[lu]\033[0m %s\n' "$*"; }
    ok()   { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
    warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
    die()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
fi

macos_require_macos() {
    local os
    os="$(uname -s)"
    [[ "$os" == Darwin ]] || die "This target is macOS-only (uname=$os).
       Linux/Windows installers stay on .github/workflows/release.yml (no macOS
       CI lane yet — Apple Developer ID signing is a local/operator path).
       Cross-platform: make help, make test, make typecheck, make sidecar."
}

# Same host-triple resolution as scripts/build-llama.sh (keep the two in sync
# if you change either). rustc is preferred; uname is the macOS-without-rustc
# fallback so `make check-sidecar` still names the file cargo would look for.
macos_host_triple() {
    if command -v rustc >/dev/null 2>&1; then
        rustc --print host-tuple 2>/dev/null && return 0
        rustc -vV 2>/dev/null | awk '/^host:/{print $2; exit}'
        return 0
    fi
    case "$(uname -sm)" in
        "Darwin arm64")  echo "aarch64-apple-darwin" ;;
        "Darwin x86_64") echo "x86_64-apple-darwin" ;;
        *) die "cannot infer host triple; install rustc or set LU_HOST_TRIPLE" ;;
    esac
}

macos_sidecar_name() {
    local triple="${LU_HOST_TRIPLE:-$(macos_host_triple)}"
    case "$triple" in
        *-windows-*) echo "lu-llama-server-$triple.exe" ;;
        *)           echo "lu-llama-server-$triple" ;;
    esac
}

macos_sidecar_path() {
    # LU_SIDECAR_PATH is a test/operator override so the real
    # src-tauri/bin/ binary is never touched by fixture suites.
    if [[ -n "${LU_SIDECAR_PATH:-}" ]]; then
        echo "$LU_SIDECAR_PATH"
        return 0
    fi
    echo "$MACOS_REPO_ROOT/src-tauri/bin/$(macos_sidecar_name)"
}

# missing | stub | ok  (also the function's stdout)
# WHY stub is distinct from missing: .github/workflows/ci.yml `touch`es an
# empty lu-llama-server-<triple> so cargo check can survive tauri-build's
# copy_binaries. That file must never be bundled into /Applications.
macos_sidecar_kind() {
    local path
    path="$(macos_sidecar_path)"
    if [[ ! -e "$path" ]]; then
        echo missing
        return 1
    fi
    if [[ ! -s "$path" ]]; then
        echo stub
        return 1
    fi
    echo ok
    return 0
}

macos_require_sidecar_exists() {
    local path kind
    path="$(macos_sidecar_path)"
    kind="$(macos_sidecar_kind || true)"
    case "$kind" in
        ok) ok "Sidecar ready: $path" ;;
        stub)
            warn "Sidecar at $path is the empty CI stub (cargo check only).
       make run / make install-app / make release need: make sidecar"
            ;;
        *)
            die "Sidecar missing at $path
       tauri-build hard-fails if bundle.externalBin is absent.
       Real binary (Metal, slow):  make sidecar
       Cargo-check stub (empty):   make sidecar-stub"
            ;;
    esac
}

macos_require_sidecar() {
    local path kind
    path="$(macos_sidecar_path)"
    kind="$(macos_sidecar_kind || true)"
    case "$kind" in
        ok) ok "Sidecar ready: $path ($(macos_sidecar_size_human "$path"))" ;;
        stub)
            die "Sidecar at $path is an empty CI stub, not a llama-server.
       GitHub cargo-check touches a 0-byte file so build.rs can copy_binaries.
       A shippable .app needs the real binary: make sidecar
       (scripts/build-llama.sh — cmake + Metal, often 15–25 min)."
            ;;
        *)
            die "Sidecar missing at $path
       tauri-build hard-fails without it. Build the host binary:
         make sidecar
       or: bash scripts/build-llama.sh && bash scripts/build-llama.sh --check"
            ;;
    esac
}

macos_sidecar_size_human() {
    if command -v du >/dev/null 2>&1; then
        du -h "$1" | awk '{print $1; exit}'
    else
        wc -c < "$1" | tr -d ' '
    fi
}

macos_tauri_bundle_root() {
    if [[ "${LU_DEBUG_BUILD:-0}" == 1 ]]; then
        echo "$MACOS_REPO_ROOT/src-tauri/target/debug/bundle"
    else
        echo "$MACOS_REPO_ROOT/src-tauri/target/release/bundle"
    fi
}

macos_operator_dir() {
    echo "${LU_OPERATOR_DIR:-$MACOS_REPO_ROOT/release/macos}"
}

macos_app_bundle() {
    local dir preferred found
    dir="$(macos_tauri_bundle_root)/macos"
    preferred="$dir/${LU_APP_PRODUCT_NAME}.app"
    if [[ -d "$preferred" ]]; then
        echo "$preferred"
        return 0
    fi
    found="$(find "$dir" -maxdepth 1 -name '*.app' -type d -print -quit 2>/dev/null || true)"
    [[ -n "$found" ]] || return 1
    echo "$found"
}

macos_dmg_file() {
    local dir found
    dir="$(macos_tauri_bundle_root)/dmg"
    # Newest mtime wins. Tauri can leave LU_3.0.0_aarch64.dmg beside our
    # LU-$VERSION+$GIT.dmg from create_dmg_from_app; alphabetical `sort | tail`
    # picked the stale Tauri artifact and notary rejected its adhoc binaries.
    found="$(find "$dir" -maxdepth 1 -name '*.dmg' -type f -print0 2>/dev/null \
        | xargs -0 ls -t 2>/dev/null | head -n1 || true)"
    [[ -n "$found" ]] || return 1
    echo "$found"
}

macos_app_version() {
    local pkg="$MACOS_REPO_ROOT/package.json"
    if command -v node >/dev/null 2>&1; then
        node -p "require('$pkg').version"
        return 0
    fi
    # Fallback: the JSON is a single-line "version": "x.y.z" in this repo.
    awk -F '"' '/"version":/ { print $4; exit }' "$pkg"
}

# SHA256SUMS.txt beside the named DMGs. `shasum -a 256 -c SHA256SUMS.txt` from
# that directory must succeed. The operator folder (release/macos/) is the
# ship location the maintainer opens; the `_RELEASES` shelf is optional and often
# unwritable, so a digest that exists only there never shows up next to the
# versioned DMG.
macos_write_sha256sums() {
    local dir="${1:-}"
    shift || return 1
    [[ -d "$dir" && $# -gt 0 ]] || return 1
    local name
    for name in "$@"; do
        [[ -f "$dir/$name" ]] || return 1
    done
    ( cd "$dir" && shasum -a 256 "$@" > SHA256SUMS.txt )
}

# Extra copy of the notarized DMG onto the operator archive shelf
# (`LU_INTERNAL_RELEASES`, default `LU_INTERNAL_RELEASES_DEFAULT`:
# iCloud `_RELEASES/LU/<version>/`). The ship artifacts are already under
# release/macos/; Apple notary + staple already succeeded by the time this
# runs. A sandbox / ACL denial on mkdir must warn and return 0 — never fail
# the lane. Quote `$shelf`: the default parent path contains a space.
macos_try_internal_shelf() {
    local shelf="${1:-}"
    local dmg="${2:-}"
    local version="${3:-}"
    local product="${LU_APP_PRODUCT_NAME:-LU}"
    local internal base
    [[ -n "$shelf" && -d "$shelf" && -n "$dmg" && -f "$dmg" && -n "$version" ]] || return 0
    internal="$shelf/$product/$version"
    base="$(basename "$dmg")"
    if mkdir -p "$internal" \
        && cp -f "$dmg" "$internal/" \
        && macos_write_sha256sums "$internal" "$base"; then
        ok "Internal shelf: $internal"
        return 0
    fi
    warn "Internal shelf skipped (could not write $internal) — operator copies under release/macos/ are the ship artifacts"
    return 0
}

macos_signing_identity_file() {
    echo "${LU_SIGNING_IDENTITY_FILE:-$LU_KEYS_DIR/signing-identity.txt}"
}

macos_notary_env_file() {
    echo "${LU_NOTARY_ENV_FILE:-$LU_KEYS_DIR/.notary.env}"
}

# Strip wrapping quotes/whitespace from a one-line identity file. Never echo
# a password file; this path is the public certificate name, not a secret.
macos_trim_identity() {
    local raw="$1"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    raw="${raw#\"}"
    raw="${raw%\"}"
    raw="${raw#\'}"
    raw="${raw%\'}"
    printf '%s' "$raw"
}

# Prints the identity to stdout. Returns 1 if a signed lane has nothing to use.
# Unsigned lanes print "-" (matches tauri.conf.json bundle.macOS.signingIdentity
# so Linux/Windows CI keeps building without an Apple cert).
macos_load_signing_identity() {
    local id file
    if [[ "${LU_UNSIGNED:-0}" == 1 ]]; then
        printf '%s\n' "-"
        return 0
    fi
    if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
        macos_trim_identity "$APPLE_SIGNING_IDENTITY"
        printf '\n'
        return 0
    fi
    if [[ -n "${LU_SIGNING_IDENTITY:-}" ]]; then
        macos_trim_identity "$LU_SIGNING_IDENTITY"
        printf '\n'
        return 0
    fi
    file="$(macos_signing_identity_file)"
    if [[ -f "$file" ]]; then
        id="$(macos_trim_identity "$(head -n1 "$file")")"
        [[ -n "$id" ]] || return 1
        printf '%s\n' "$id"
        return 0
    fi
    return 1
}

macos_require_signing_identity() {
    local id
    if ! id="$(macos_load_signing_identity)"; then
        die "Signing identity missing.

  A notarized or Developer ID build needs a Keychain identity, for example:
    Developer ID Application: Your Name (TEAMID)

  Set one of (never commit the value):
    export APPLE_SIGNING_IDENTITY='Developer ID Application: …'
    export LU_SIGNING_IDENTITY='…'          # LU-specific alias
    printf '%s\\n' 'Developer ID Application: …' > ~/.keys/signing-identity.txt
    chmod 600 ~/.keys/signing-identity.txt

  For an unsigned local .app / .dmg (Gatekeeper will warn):
    make release-unsigned

  Identities currently in Keychain: make info-certs"
    fi
    if [[ "$id" == "-" ]]; then
        ok "Unsigned lane (signingIdentity=-)"
        return 0
    fi
    if command -v security >/dev/null 2>&1; then
        if ! security find-identity -v -p codesigning 2>/dev/null | grep -F -q "$id"; then
            die "Signing identity '$id' is not in this Keychain.
       make info-certs  # list Developer ID / Apple Development identities
       The string must match find-identity exactly (including the team id)."
        fi
    fi
    ok "Signing identity: $id"
}

# Map a ~/.keys/.notary.env (NOTARY_APPLE_ID / NOTARY_TEAM_ID /
# NOTARY_PASSWORD) onto the APPLE_* names Tauri 2 and notarytool already
# understand. Existing APPLE_* win. API-key auth (APPLE_API_KEY +
# APPLE_API_ISSUER + APPLE_API_KEY_PATH) is preferred when present — it does
# not use an Apple ID password at all.
macos_load_notary_env() {
    if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
        return 0
    fi
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
        return 0
    fi
    local file
    file="$(macos_notary_env_file)"
    [[ -f "$file" ]] || return 1
    # shellcheck disable=SC1090
    source "$file"
    if [[ -z "${APPLE_ID:-}" && -n "${NOTARY_APPLE_ID:-}" ]]; then
        export APPLE_ID="$NOTARY_APPLE_ID"
    fi
    if [[ -z "${APPLE_PASSWORD:-}" && -n "${NOTARY_PASSWORD:-}" ]]; then
        export APPLE_PASSWORD="$NOTARY_PASSWORD"
    fi
    if [[ -z "${APPLE_TEAM_ID:-}" && -n "${NOTARY_TEAM_ID:-}" ]]; then
        export APPLE_TEAM_ID="$NOTARY_TEAM_ID"
    fi
    if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
        return 0
    fi
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]
}

macos_notary_mode() {
    if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
        echo api-key
        return 0
    fi
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
        echo apple-id
        return 0
    fi
    echo missing
    return 1
}

macos_require_notary() {
    macos_load_notary_env || true
    local mode
    mode="$(macos_notary_mode || true)"
    case "$mode" in
        api-key)
            [[ -f "${APPLE_API_KEY_PATH}" ]] \
                || die "APPLE_API_KEY_PATH does not exist: $APPLE_API_KEY_PATH"
            ok "Notary credentials: App Store Connect API key (path set, value not printed)"
            ;;
        apple-id)
            ok "Notary credentials: Apple ID set / team ${APPLE_TEAM_ID} (password not printed)"
            ;;
        *)
            die "Notarization credentials missing.

  Option A — App Store Connect API key (preferred):
    export APPLE_API_KEY='KEYID'
    export APPLE_API_ISSUER='uuid'
    export APPLE_API_KEY_PATH=\$HOME/.keys/AuthKey_KEYID.p8

  Option B — Apple ID + app-specific password (Tauri 2 / notarytool):
    export APPLE_ID='you@example.com'
    export APPLE_PASSWORD='app-specific-password'
    export APPLE_TEAM_ID='TEAMID'

  Option C — a notary env file (never commit it):
    ~/.keys/.notary.env  with NOTARY_APPLE_ID, NOTARY_TEAM_ID, NOTARY_PASSWORD
    chmod 600 ~/.keys/.notary.env

  For a signed .app without Apple notarization: make release-local"
            ;;
    esac
}

# Redacted operator dump. Passwords, API keys, and .notary.env bodies stay out.
macos_print_env() {
    local kind id_state notary_file ident_file mode id
    kind="$(macos_sidecar_kind || true)"
    ident_file="$(macos_signing_identity_file)"
    notary_file="$(macos_notary_env_file)"
    macos_load_notary_env >/dev/null 2>&1 || true
    mode="$(macos_notary_mode || true)"
    if id="$(macos_load_signing_identity 2>/dev/null)"; then
        id_state="$id"
    else
        id_state="(unset)"
    fi
    printf 'os:                  %s\n' "$(uname -s)"
    printf 'host triple:         %s\n' "${LU_HOST_TRIPLE:-$(macos_host_triple)}"
    printf 'app version:         %s\n' "$(macos_app_version)"
    printf 'bundle id:           %s\n' "$LU_APP_BUNDLE_ID"
    printf 'sidecar:             %s\n' "$(macos_sidecar_path)"
    printf 'sidecar kind:        %s\n' "$kind"
    printf 'signing identity:    %s\n' "$id_state"
    printf 'identity file:       %s (%s)\n' "$ident_file" "$( [[ -f "$ident_file" ]] && echo present || echo absent )"
    printf 'notary env file:     %s (%s)\n' "$notary_file" "$( [[ -f "$notary_file" ]] && echo present || echo absent )"
    printf 'notary mode:         %s\n' "$mode"
    printf 'APPLE_ID:            %s\n' "$( [[ -n "${APPLE_ID:-}" ]] && echo set || echo unset )"
    printf 'APPLE_PASSWORD:      %s\n' "$( [[ -n "${APPLE_PASSWORD:-}" ]] && echo set || echo unset )"
    printf 'APPLE_TEAM_ID:       %s\n' "${APPLE_TEAM_ID:-unset}"
    printf 'APPLE_API_KEY:       %s\n' "$( [[ -n "${APPLE_API_KEY:-}" ]] && echo set || echo unset )"
    printf 'APPLE_API_KEY_PATH:  %s\n' "${APPLE_API_KEY_PATH:-unset}"
    printf 'TAURI_SIGNING_PRIVATE_KEY (updater minisign): %s\n' \
        "$( [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] && echo set || echo unset )"
    printf 'LU_BUILD_KEYCHAIN:   %s (%s)\n' \
        "${LU_BUILD_KEYCHAIN:-$HOME/Library/Keychains/lu-build.keychain-db}" \
        "$( [[ -f "${LU_BUILD_KEYCHAIN:-$HOME/Library/Keychains/lu-build.keychain-db}" ]] && echo present || echo absent )"
    printf 'tauri bundle root:   %s\n' "$(macos_tauri_bundle_root)"
    printf 'operator copies:     %s\n' "$(macos_operator_dir)"
    if macos_app_bundle >/dev/null 2>&1; then
        printf 'current .app:        %s\n' "$(macos_app_bundle)"
    else
        printf 'current .app:        (none — run make release-local)\n'
    fi
    if macos_dmg_file >/dev/null 2>&1; then
        printf 'current .dmg:        %s\n' "$(macos_dmg_file)"
    else
        printf 'current .dmg:        (none)\n'
    fi
}

macos_check_signing() {
    local app
    app="$(macos_app_bundle)" || die "No .app under $(macos_tauri_bundle_root)/macos — build first (make release-local)."
    log "codesign --verify --deep --strict $app"
    codesign --verify --deep --strict --verbose=2 "$app"
    log "codesign -dv"
    codesign -dv --verbose=4 "$app" 2>&1 | grep -E 'Authority|Identifier|TeamIdentifier|Signature=' || true
    if command -v spctl >/dev/null 2>&1; then
        log "spctl --assess (may fail before notarization/staple)"
        spctl --assess --type execute --verbose "$app" 2>&1 | tail -5 || warn "spctl assessment failed (unsigned or not notarized yet)"
    fi
    if [[ -d "$app" ]]; then
        xcrun stapler validate "$app" 2>&1 | tail -3 || warn "no staple ticket on .app yet"
    fi
    if dmg="$(macos_dmg_file 2>/dev/null)"; then
        xcrun stapler validate "$dmg" 2>&1 | tail -3 || warn "no staple ticket on .dmg yet"
    fi
    ok "Signature inspection finished for $app"
}

macos_info_artifacts() {
    local root app dmg op
    root="$(macos_tauri_bundle_root)"
    op="$(macos_operator_dir)"
    if [[ ! -d "$root" ]]; then
        printf 'empty: %s does not exist — run make release or make release-local\n' "$root"
        return 0
    fi
    log "Tauri bundle: $root"
    find "$root" -maxdepth 3 \( -name '*.app' -o -name '*.dmg' -o -name '*.pkg' \) -print 2>/dev/null \
        | while IFS= read -r p; do du -sh "$p"; done
    if app="$(macos_app_bundle 2>/dev/null)"; then
        log "stapler .app"
        xcrun stapler validate "$app" 2>&1 | tail -2 || true
    fi
    if dmg="$(macos_dmg_file 2>/dev/null)"; then
        log "stapler .dmg"
        xcrun stapler validate "$dmg" 2>&1 | tail -2 || true
    fi
    if [[ -d "$op" ]]; then
        log "Operator copies: $op"
        ls -lh "$op" 2>/dev/null || true
    fi
}

macos_info_certs() {
    if ! command -v security >/dev/null 2>&1; then
        die "security(1) not available — macOS Keychain required for info-certs"
    fi
    security find-identity -v -p codesigning | grep -E 'Developer ID|Apple Development|Apple Distribution' || true
}
