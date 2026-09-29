#!/usr/bin/env bash
# shellcheck shell=bash
# Build-keychain preflight — unlock the dedicated Developer ID keychain inside
# the same session that runs codesign.
#
# WHY this exists:
# A keychain's unlocked state belongs to the security session that unlocked it.
# A keychain the operator opened in their GUI session is still LOCKED for a
# release driven over SSH — and codesign then dies with the famously unhelpful
# `errSecInternalComponent`, minutes into `tauri build`. Unlocking has to
# happen inside the process tree that signs. Unlocking beforehand from another
# session does not carry over.
#
# LU defaults to `$HOME/Library/Keychains/lu-build.keychain-db`. If that file
# is absent, unlock is a no-op: identities in the login keychain still work.
# Point `LU_BUILD_KEYCHAIN` at an existing dedicated keychain (some operators
# already keep one for Developer ID) without committing that path.
#
# Callers supply `ok`/`warn`/`die`. Sourced, never executed.

# >>> build-keychain preflight — extracted verbatim by scripts/test-build-keychain.sh >>>
# Both locations are overridable so a second build machine (or a test) can point
# them elsewhere without editing this file. KEYS_DIR carries its own default
# here so a caller running under `set -u` that has no reason to know about
# ~/.keys can still source this.
BUILD_KEYCHAIN="${LU_BUILD_KEYCHAIN:-$HOME/Library/Keychains/lu-build.keychain-db}"
BUILD_KEYCHAIN_PASSWORD_FILE="${LU_BUILD_KEYCHAIN_PASSWORD_FILE:-${KEYS_DIR:-$HOME/.keys}/.build-keychain-pw}"

# session_can_prompt — true only in an Aqua (GUI login) session, the one place
# where Security can put a SecurityAgent unlock panel on a screen. An SSH or
# launchd-driven session cannot, so there a keychain call fails closed instead
# of blocking forever on a modal nobody can see.
session_can_prompt() {
    [[ -z "${SSH_CONNECTION:-}${SSH_TTY:-}" ]] || return 1
    [[ "$(launchctl managername 2>/dev/null)" == "Aqua" ]]
}

# build_keychain_is_locked — called ONLY from the branch that has already
# established this session cannot prompt. `show-keychain-info` on a locked
# keychain is not a passive read: in an Aqua session it raises a modal unlock
# panel and blocks until somebody answers it. Fenced behind session_can_prompt
# it is a deterministic non-interactive lock probe; used anywhere else it is a
# hang waiting to happen, so do not lift it out of this branch.
build_keychain_is_locked() {
    ! security show-keychain-info "$BUILD_KEYCHAIN" >/dev/null 2>&1
}

# unlock_build_keychain — idempotent and never interactive: given -p, `security
# unlock-keychain` also succeeds on an already-unlocked keychain and never
# reaches SecurityAgent. Cheap enough to call before every signing step, which
# is the point — a keychain carries an inactivity auto-lock timeout, while a
# Tauri release spends minutes inside rustc and minutes more inside notarization
# between two signatures.
#
# The password does travel through argv, where `ps` can see it for the lifetime
# of one exec. Accepted deliberately: `security` has no stdin or password-file
# mode, so the only alternative is the interactive prompt this whole preflight
# exists to avoid.

# build_keychain_password_file_is_private — $HOME is world-executable on macOS,
# so this file's confidentiality rests entirely on its own mode: a stray
# `chmod 644` hands the keychain password to every local account. Required:
# owned by the user running the build, with no group or other bits — 0600, or
# 0400. Anything wider is refused rather than read.
#
# `stat -L` resolves a symlink on purpose: the mode that matters belongs to the
# file whose bytes we are about to hand to `security`, not to the link.
build_keychain_password_file_is_private() {
    local metadata owner mode

    metadata="$(/usr/bin/stat -L -f '%u %Lp' "$BUILD_KEYCHAIN_PASSWORD_FILE" 2>/dev/null)" || return 1
    owner="${metadata%% *}"
    mode="${metadata##* }"
    [[ -n "$owner" && -n "$mode" ]] || return 1
    [[ "$owner" == "$(/usr/bin/id -u)" ]] || return 1
    (( 8#$mode & 8#077 )) && return 1
    return 0
}

# Status: 0 unlocked (or no dedicated build keychain here), 1 no readable
# password file, 2 the stored password did not unlock the keychain, 3 the
# password file is not an owner-only secret (wrong owner, unreadable owner or
# mode, or group/other bits set).
unlock_build_keychain() {
    local password

    [[ -f "$BUILD_KEYCHAIN" ]] || return 0
    [[ -r "$BUILD_KEYCHAIN_PASSWORD_FILE" ]] || return 1
    build_keychain_password_file_is_private || return 3
    password="$(head -n1 "$BUILD_KEYCHAIN_PASSWORD_FILE")" || return 1
    [[ -n "$password" ]] || return 1
    security unlock-keychain -p "$password" "$BUILD_KEYCHAIN" >/dev/null 2>&1 || return 2
    return 0
}

# Fail here, with the keychain named and the remedy spelled out, rather than
# eight minutes later inside codesign with an errSecInternalComponent.
#
# Only the lane whose signing identity lives in this keychain may be *gated* on
# it. LANE_SIGNS_FROM_BUILD_KEYCHAIN is decided up in the arg block, long before
# this runs, and defaults to 1 here: an unset flag keeps the strict gate rather
# than silently opening it.
preflight_build_keychain() {
    local status=0

    (( ${LANE_SIGNS_FROM_BUILD_KEYCHAIN:-1} )) || return 0
    [[ -f "$BUILD_KEYCHAIN" ]] || return 0

    unlock_build_keychain || status=$?
    case "$status" in
        0)
            ok "Build keychain unlocked for this session: $BUILD_KEYCHAIN"
            ;;
        2)
            die "The password in $BUILD_KEYCHAIN_PASSWORD_FILE does not unlock $BUILD_KEYCHAIN.
       Correct the stored password, or unlock the keychain by hand from THIS
       session before re-running:
         security unlock-keychain '$BUILD_KEYCHAIN'"
            ;;
        3)
            die "Build-keychain password file is not an owner-only secret: $BUILD_KEYCHAIN_PASSWORD_FILE
       It holds the keychain password in cleartext and \$HOME is
       world-executable, so the file's own mode is the whole of its
       confidentiality. Refusing to use it until it is owned by this user and
       mode 0600, or 0400 for a file deliberately kept read-only:
         ls -l \"$BUILD_KEYCHAIN_PASSWORD_FILE\"
         chmod 600 \"$BUILD_KEYCHAIN_PASSWORD_FILE\"
       If it was group- or world-accessible, treat the stored password as
       disclosed: change it on the keychain and re-store it."
            ;;
        *)
            if session_can_prompt; then
                warn "No build-keychain password at $BUILD_KEYCHAIN_PASSWORD_FILE — signing may raise an interactive unlock panel."
            elif build_keychain_is_locked; then
                die "Build keychain is LOCKED and this session cannot unlock it: $BUILD_KEYCHAIN
       Unlocking does not cross security sessions, so opening it in a GUI
       session does not help a release driven over SSH — codesign would fail
       with errSecInternalComponent minutes into the build.
       Store the keychain password so this script unlocks itself:
         printf '%s' 'PASSWORD' > \"$BUILD_KEYCHAIN_PASSWORD_FILE\"
         chmod 600 \"$BUILD_KEYCHAIN_PASSWORD_FILE\"
       Or unlock it by hand from THIS session before re-running:
         security unlock-keychain '$BUILD_KEYCHAIN'"
            else
                ok "Build keychain already unlocked in this session: $BUILD_KEYCHAIN"
            fi
            ;;
    esac
}
# <<< build-keychain preflight <<<
