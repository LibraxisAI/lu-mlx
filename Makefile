# Locally Uncensored (LU) — desktop app build facade
# Thin Makefile. Non-trivial macOS sign/notarize/install lives in scripts/.
#
# WHY this exists: LU is a Tauri 2 app. GitHub release.yml ships Windows + Linux
# only (no macOS CI lane yet). Operators still need a local
# path: `make install-app` into /Applications and `make release` for a signed,
# notarized DMG. Canonical recipes stay here so `mise run <task>` can wrap them
# without drifting (see mise.toml).
#
# WHY every Tauri and cargo recipe stays at `.` (never `cd src-tauri`)
# ---------------------------------------------------------------------
# `cd src-tauri` then `tauri` / cargo-tauri misses the Vite frontend, root
# package.json, and the Tauri 2 project file. rustc is the same constraint
# for agents: `cd src-tauri && cargo` trains the next command (`loct`) to
# run in the crate and create a nested snapshot. Always:
#   cargo --manifest-path src-tauri/Cargo.toml …
# from the git root. CARGO_MANIFEST_DIR is still src-tauri (build.rs is
# fine). scripts/assert-loct-repo-root.sh + the sentinel FILE
# src-tauri/.loctree make an accidental `cd src-tauri && loct` fail closed.
#
# WHY artifacts are NOT in dist/: src-tauri/tauri.conf.json frontendDist is
# already ../dist (Vite). Operator copies go to release/macos/.
#
# Quick start:
#   make                 # = make help
#   make run             # tauri:dev
#   make test            # vitest
#   make install-app     # signed local .app → /Applications (macOS, LU idle)
#   make release         # signed + notarized .app + .dmg (macOS)
#
# Required env for notarization (never commit these):
#   Signing identity:
#     APPLE_SIGNING_IDENTITY or LU_SIGNING_IDENTITY
#     or ~/.keys/signing-identity.txt (chmod 600)
#   Notary (any one group):
#     APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH
#     or APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID
#     or ~/.keys/.notary.env (NOTARY_APPLE_ID, NOTARY_TEAM_ID, NOTARY_PASSWORD)
#   Optional dedicated keychain unlock (SSH/errSecInternalComponent trap):
#     LU_BUILD_KEYCHAIN, LU_BUILD_KEYCHAIN_PASSWORD_FILE (~/.keys/.build-keychain-pw)
#   Optional updater minisign (different from Apple notarization):
#     TAURI_SIGNING_PRIVATE_KEY  — enables src-tauri/tauri.release.conf.json overlay
#
# tauri.conf.json keeps bundle.macOS.signingIdentity="-" so Linux/Windows CI
# and scripts/ci-tauri-build.sh stay keyless. Do not put a Developer ID there.
#
# Conventions:
#   `info-*` targets are inspection (read-only)
#   macOS-only ship lanes fail closed on Linux/Windows with a message
#   `sidecar-stub` never clobbers a real llama-server binary

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO_ROOT  := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
SCRIPTS    := $(REPO_ROOT)/scripts
SRC_TAURI  := $(REPO_ROOT)/src-tauri
CARGO      := cargo --manifest-path $(SRC_TAURI)/Cargo.toml
BIN_DIR    := $(SRC_TAURI)/bin
OPERATOR   := $(REPO_ROOT)/release/macos
BUNDLE_REL := $(SRC_TAURI)/target/release/bundle
BUNDLE_DBG := $(SRC_TAURI)/target/debug/bundle

C_CYAN   := \033[36m
C_GREEN  := \033[32m
C_YELLOW := \033[33m
C_RED    := \033[31m
C_RESET  := \033[0m

# =========================================================================
# DEVELOPMENT (daily driver)
# =========================================================================

.PHONY: build
build:  ## Debug cargo build (not a bundled .app)
build: sidecar-exists
	@$(CARGO) build

.PHONY: build-release
build-release:  ## Release-mode cargo build only (no .app, no notarize)
build-release: sidecar-exists
	@$(CARGO) build --release

.PHONY: run
run:  ## tauri:dev (hot-reload React + live Rust; needs a real sidecar on macOS)
	@printf "$(C_YELLOW)[sidecar]$(C_RESET) builtin engine needs a non-empty lu-llama-server-<triple>; make sidecar if install-app would refuse the stub\n"
	npm run tauri:dev

.PHONY: run-release
run-release:  ## Build signed .app (no notarize) and launch it
run-release: release-local
	@open "$(BUNDLE_REL)/macos/LU.app"

.PHONY: install-app
install-app:  ## Build signed .app, then install only when LU is idle
install-app: macos-only
	@$(SCRIPTS)/install-built-app.sh --check-idle
	@$(MAKE) release-local
	@$(SCRIPTS)/install-built-app.sh

.PHONY: install-app-debug
install-app-debug:  ## Debug-bundle .app → /Applications (macOS, LU idle)
install-app-debug: macos-only
	@$(SCRIPTS)/install-built-app.sh --check-idle
	@$(SCRIPTS)/macos-release.sh --debug --no-notarize --no-dmg
	@LU_DEBUG_BUILD=1 $(SCRIPTS)/install-built-app.sh

.PHONY: install-built-app
install-built-app:  ## Install the existing .app without rebuilding or quitting LU
install-built-app: macos-only
	@$(SCRIPTS)/install-built-app.sh

.PHONY: open
open:  ## Open the current release .app
open: macos-only
	@[[ -d "$(BUNDLE_REL)/macos/LU.app" ]] || { printf "$(C_RED)[fail]$(C_RESET) no $(BUNDLE_REL)/macos/LU.app — make release-local\n"; exit 1; }
	@open "$(BUNDLE_REL)/macos/LU.app"

.PHONY: open-dmg
open-dmg:  ## Open the current DMG in Finder
open-dmg: macos-only
	@dmg="$$(find $(BUNDLE_REL)/dmg -maxdepth 1 -name '*.dmg' -type f | sort | tail -n1)"; \
	[[ -n "$$dmg" ]] || { printf "$(C_RED)[fail]$(C_RESET) no DMG — make release or make notarize\n"; exit 1; }; \
	open "$$dmg"

.PHONY: clean
clean:  ## Remove Vite dist/, operator release/macos/, and Tauri bundle dirs (not rustc target)
	@printf "$(C_CYAN)[clean]$(C_RESET) dist/ (Vite) + release/macos/ + src-tauri/target/{release,debug}/bundle\n"
	@# Rename-aside before delete: a live bundler writing into bundle/ races a
	@# plain rm -rf (ENOTEMPTY). Unlock first: signed trees can be mode 0444.
	@for d in $(REPO_ROOT)/dist $(OPERATOR) $(BUNDLE_REL) $(BUNDLE_DBG); do \
		[ -e "$$d" ] || continue; \
		trash="$$d.trash.$$$$"; \
		mv "$$d" "$$trash" 2>/dev/null || trash="$$d"; \
		chmod -R u+w "$$trash" 2>/dev/null || true; \
		rm -rf "$$trash" 2>/dev/null || true; \
	done
	@printf "$(C_GREEN)[ ok ]$(C_RESET) cleaned\n"

.PHONY: clean-deep
clean-deep: clean  ## Clean + nuke src-tauri/target (full rustc rebuild next time)
	@printf "$(C_CYAN)[clean-deep]$(C_RESET) removing src-tauri/target (keeps .llama-build cache)\n"
	@if [[ -e $(SRC_TAURI)/target ]]; then \
		trash="$(SRC_TAURI)/target.trash.$$$$"; \
		mv "$(SRC_TAURI)/target" "$$trash" 2>/dev/null || trash="$(SRC_TAURI)/target"; \
		chmod -R u+w "$$trash" 2>/dev/null || true; \
		rm -rf "$$trash" 2>/dev/null || true; \
	fi
	@printf "$(C_GREEN)[ ok ]$(C_RESET) deep-cleaned\n"

# =========================================================================
# QUALITY GATES
# =========================================================================

.PHONY: test
test:  ## Unit tests (vitest — CI gate)
	npx vitest run

.PHONY: typecheck
typecheck:  ## TypeScript check (CI gate)
	npx tsc --noEmit

.PHONY: test-scripts
test-scripts:  ## Shell-side unit tests (sidecar/identity/install/keychain + make help)
	@$(SCRIPTS)/test-macos-release.sh
	@$(SCRIPTS)/test-install-built-app.sh
	@$(SCRIPTS)/test-build-keychain.sh
	@help_out="$$($(MAKE) help)"; \
	  printf '%s\n' "$$help_out" | grep -E -q 'install-app' \
	    || { printf "$(C_RED)[fail]$(C_RESET) make help missing install-app\n"; exit 1; }; \
	  printf '%s\n' "$$help_out" | grep -E -q '[[:space:]]release[[:space:]]' \
	    || { printf "$(C_RED)[fail]$(C_RESET) make help missing release\n"; exit 1; }
	@printf "$(C_GREEN)[ ok ]$(C_RESET) help lists install-app and release\n"

.PHONY: lint
lint:  ## eslint (historically non-gating in CI; still a local target)
	npm run lint

.PHONY: gates
gates: typecheck test test-scripts  ## Gating checks: tsc + vitest + shell tests
	@printf "$(C_GREEN)[ ok ]$(C_RESET) gates passed\n"

# =========================================================================
# SIDECAR (llama.cpp externalBin)
# =========================================================================

.PHONY: sidecar
sidecar:  ## Build the host lu-llama-server sidecar (scripts/build-llama.sh, slow)
	@$(SCRIPTS)/build-llama.sh

.PHONY: check-sidecar
check-sidecar:  ## Fail if sidecar is missing or the empty CI stub
	@bash -c 'source "$(SCRIPTS)/lib/macos-app.sh" && macos_require_sidecar'

.PHONY: sidecar-exists
sidecar-exists:  ## Sidecar file exists (stub allowed, with a warning)
	@bash -c 'source "$(SCRIPTS)/lib/macos-app.sh" && macos_require_sidecar_exists'

.PHONY: sidecar-stub
sidecar-stub:  ## Empty sidecar for cargo check ONLY — never clobbers a real binary
	@mkdir -p "$(BIN_DIR)"
	@triple="$$(rustc --print host-tuple 2>/dev/null || rustc -vV | awk '/^host:/{print $$2}')"; \
	case "$$triple" in \
	  *-windows-*) path="$(BIN_DIR)/lu-llama-server-$$triple.exe" ;; \
	  *)           path="$(BIN_DIR)/lu-llama-server-$$triple" ;; \
	esac; \
	if [[ -s "$$path" ]]; then \
	  printf "$(C_GREEN)[ ok ]$(C_RESET) real sidecar already at $$path — stub not written\n"; \
	else \
	  touch "$$path"; \
	  printf "$(C_YELLOW)[stub]$(C_RESET) empty $$path for cargo check. make install-app / make release refuse this file.\n"; \
	fi

.PHONY: sidecar-check-boot
sidecar-check-boot:  ## Boot the host sidecar and probe /health (scripts/build-llama.sh --check)
	@$(SCRIPTS)/build-llama.sh --check

.PHONY: frontend-stub
frontend-stub:  ## Placeholder dist/index.html so build.rs can cargo-check without Vite
	@mkdir -p "$(REPO_ROOT)/dist"
	@if [[ ! -f "$(REPO_ROOT)/dist/index.html" ]]; then \
	  printf '<!doctype html><title>make frontend-stub</title>\n' > "$(REPO_ROOT)/dist/index.html"; \
	  printf "$(C_YELLOW)[stub]$(C_RESET) wrote dist/index.html placeholder (same reason as ci.yml)\n"; \
	else \
	  printf "$(C_GREEN)[ ok ]$(C_RESET) dist/index.html already present\n"; \
	fi

# =========================================================================
# RELEASE PIPELINE (macOS Developer ID + notarytool)
# =========================================================================

.PHONY: release
release:  ## Full signed + notarized .app + .dmg (gated by tsc+vitest+script tests)
release: macos-only gates check-sidecar
	@$(SCRIPTS)/macos-release.sh

.PHONY: release-local
release-local:  ## Signed production-identity .app only (no notarize, no DMG)
release-local: macos-only gates check-sidecar
	@$(SCRIPTS)/macos-release.sh --no-notarize --no-dmg

.PHONY: release-unsigned
release-unsigned:  ## Unsigned local .app + .dmg (Gatekeeper warns; no Apple identity)
release-unsigned: macos-only check-sidecar
	@$(SCRIPTS)/macos-release.sh --unsigned --no-notarize

.PHONY: release-clean
release-clean:  ## Clean bundle dirs + full notarized release (most reproducible)
release-clean: macos-only clean gates check-sidecar
	@$(SCRIPTS)/macos-release.sh --clean

.PHONY: notarize
notarize:  ## DMG-only: package + notarize + staple from the existing signed .app
notarize: macos-only
	@$(SCRIPTS)/macos-release.sh --dmg-only

.PHONY: staple
staple:  ## Staple notarization tickets onto the existing .app + .dmg (no rebuild)
staple: macos-only
	@$(SCRIPTS)/macos-release.sh --staple-only

.PHONY: release-plan
release-plan:  ## Preflight + print the macOS release lane (no compile, no notary submit)
release-plan: macos-only
	@$(SCRIPTS)/macos-release.sh --print-plan

.PHONY: release-appstore
release-appstore:  ## Not applicable: LU is not distributed via the Mac App Store
	@printf "$(C_YELLOW)[skip]$(C_RESET) LU ships GitHub .dmg / NSIS / AppImage / deb / rpm, not Mac App Store.\n"
	@printf "       There is no Mac App Store lane and no MAS entitlements.\n"
	@exit 1

# =========================================================================
# INSPECTION
# =========================================================================

.PHONY: loc
loc:  ## Codebase overview via loctree (always repo root, never src-tauri/)
	@cd "$(REPO_ROOT)" && $(SCRIPTS)/assert-loct-repo-root.sh
	@cd "$(REPO_ROOT)" && command -v loct >/dev/null 2>&1 && loct --for-ai 2>/dev/null | head -40 \
		|| printf "$(C_YELLOW)[skip]$(C_RESET) loctree CLI not on PATH\n"

.PHONY: tree
tree:  ## Source tree via loct (always repo root)
	@cd "$(REPO_ROOT)" && $(SCRIPTS)/assert-loct-repo-root.sh
	@cd "$(REPO_ROOT)" && command -v loct >/dev/null 2>&1 && loct tree --depth 2 \
		|| printf "$(C_YELLOW)[skip]$(C_RESET) loctree CLI not on PATH\n"

.PHONY: log
log:  ## Recent commit log
	@git log --oneline --decorate -10

.PHONY: info-status
info-status:  ## Git status + branch (read-only)
	@git status -sb

.PHONY: info-artifacts
info-artifacts:  ## Inspect Tauri bundle + release/macos (sizes + stapler)
	@bash -c 'source "$(SCRIPTS)/lib/macos-app.sh" && macos_info_artifacts'

.PHONY: info-certs
info-certs:  ## Show signing identities in Keychain (macOS)
info-certs: macos-only
	@bash -c 'source "$(SCRIPTS)/lib/macos-app.sh" && macos_info_certs'

.PHONY: print-env
print-env:  ## Redacted signing/notary/sidecar dump (secrets never printed)
	@bash -c 'source "$(SCRIPTS)/lib/macos-app.sh" && macos_print_env'

.PHONY: info-env
info-env: print-env  ## Alias for print-env

.PHONY: check-signing
check-signing:  ## codesign --verify + stapler + spctl on the current .app
check-signing: macos-only
	@bash -c 'source "$(SCRIPTS)/lib/macos-app.sh" && macos_check_signing'

# =========================================================================
# CI
# =========================================================================

.PHONY: ci
ci:  ## Local CI analog: stubs if needed + tsc + vitest + script tests + cargo check
ci: sidecar-stub frontend-stub gates cargo-check
	@printf "$(C_GREEN)[ ok ]$(C_RESET) local CI analog complete\n"

.PHONY: cargo-check
cargo-check:  ## rustc cargo check via --manifest-path (cwd stays repo root)
cargo-check: sidecar-stub frontend-stub
	@$(CARGO) check

.PHONY: preflight
preflight: release-plan  ## Alias for release-plan

.PHONY: sidecar-health
sidecar-health: sidecar-check-boot  ## Alias for sidecar-check-boot

.PHONY: ci-tauri-build
ci-tauri-build:  ## Keyless tauri build gate (scripts/ci-tauri-build.sh — heavy)
	@$(SCRIPTS)/ci-tauri-build.sh

# =========================================================================
# OS GATE
# =========================================================================

.PHONY: macos-only
macos-only:  ## Internal: fail closed on non-Darwin for ship/install lanes
	@case "$$(uname -s)" in \
	  Darwin) ;; \
	  *) \
	    printf "$(C_YELLOW)[fail]$(C_RESET) macOS-only target (uname=$$(uname -s)).\n"; \
	    printf "       Linux/Windows installers: .github/workflows/release.yml\n"; \
	    printf "       Cross-platform: make help / make test / make sidecar / make ci\n"; \
	    exit 1 ;; \
	esac

# =========================================================================
# HELP (default target)
# =========================================================================

.PHONY: help
help:  ## Show this help
	@printf "\n$(C_CYAN)Locally Uncensored (LU)$(C_RESET) — Tauri 2 local AI studio\n"
	@printf "$(C_CYAN)$$(printf '%.s─' {1..72})$(C_RESET)\n\n"
	@awk 'BEGIN {FS = ":.*?## "} \
		/^# =+$$/ { in_section=1; next } \
		in_section && /^# / { sub(/^# /, ""); printf "\n  $(C_YELLOW)%s$(C_RESET)\n", $$0; in_section=0; next } \
		/^[a-zA-Z][a-zA-Z0-9_\\-]*:.*?##/ { \
			target=$$1; \
			printf "    $(C_GREEN)%-20s$(C_RESET) %s\n", target, $$2 \
		}' $(MAKEFILE_LIST)
	@printf "\n  $(C_CYAN)Quick start:$(C_RESET)\n"
	@printf "    make run              # tauri:dev\n"
	@printf "    make test             # vitest\n"
	@printf "    make sidecar          # build lu-llama-server-<triple>\n"
	@printf "    make install-app      # signed .app → /Applications (macOS)\n"
	@printf "    make release          # signed + notarized .app + .dmg (macOS)\n"
	@printf "    make print-env        # redacted credential/sidecar dump\n"
	@printf "    make release-plan     # preflight only (no compile)\n"
	@printf "    mise run install-app  # same as make (see mise.toml)\n\n"
	@printf "  $(C_CYAN)Notarization env:$(C_RESET) APPLE_SIGNING_IDENTITY or ~/.keys/signing-identity.txt;\n"
	@printf "    APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID or ~/.keys/.notary.env (NOTARY_*).\n"
	@printf "    Never commit those files. Missing identity → make release-unsigned.\n\n"
