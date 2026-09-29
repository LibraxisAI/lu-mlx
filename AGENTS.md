# AGENTS.md — Locally Uncensored (LU)

Guidance for AI coding agents working in this repository. Read this before making changes.

## Project overview

**Locally Uncensored** (short in-app name: **LU**, by LU Labs / PurpleDoubleD) is a free, open-source (AGPL-3.0-only) **local AI studio desktop app**. It combines AI chat, a coding agent, image generation, and video generation in one installer, running against local inference backends (no cloud required). Current version: **2.6.7**.

- Repository: https://github.com/purpledoubled/locally-uncensored
- Ships for **Windows 10/11** (NSIS/MSI) and **Linux** (deb/rpm/AppImage). macOS is source-build only; there is no macOS release CI lane yet.
- Auto-detects 12 local text backends (Ollama, LM Studio, vLLM, KoboldCpp, Jan, llama.cpp, LocalAI, GPT4All, TabbyAPI, Aphrodite, SGLang, TGI) plus a **built-in engine** (a bundled llama.cpp `llama-server` sidecar), and ComfyUI for image/video. On Apple Silicon there are also MLX-based image/video lanes.
- Optional cloud providers (OpenAI, Anthropic, OpenRouter, Groq, LU Cloud, …) use the user's own keys. Supabase backs the optional LU Cloud accounts.
- Privacy posture: no telemetry, no analytics.

## Technology stack

**Frontend** (`src/`) — runs in the Tauri webview, or standalone in a browser for dev:

- React 19 + TypeScript (strict mode), Vite 8, Tailwind CSS 4 (via `@tailwindcss/vite`)
- Zustand 5 for state, with localStorage persistence (`src/stores/`, ~36 stores)
- Framer Motion, lucide-react, react-markdown + KaTeX, three.js / react-three-fiber, pdfjs-dist, mammoth, jszip

**Backend** (`src-tauri/`) — Rust, Tauri 2:

- Tauri plugins: shell, updater, single-instance. Custom command modules in `src-tauri/src/commands/` (28 modules: engine lifecycle, ComfyUI control, downloads, GPU detection, filesystem, proxy, secrets/keychain, remote access, TTS/whisper, trainer, …).
- Key crates: `tokio`, `reqwest`, `axum` + `tokio-tungstenite` (the Remote Access LAN/tunnel server), `sysinfo`, `keyring` (Windows/macOS only), `zip`, `tracing`.
- `src-tauri/resources/` bundles `whisper_server.py` (STT) and an `mlx/` Python environment spec; `src-tauri/bin/` holds the `lu-llama-server-<triple>` sidecar (built by `scripts/build-llama.sh`, **not committed** — only the macOS arm64 one may be present locally).
- Cargo features: `insecure-test-keychain` — test-only, **never** enable in a shipped build.

**Website/docs**: `docs/` is the static marketing site (locallyuncensored.com), unrelated to the app build.

## Repository layout

```
src/            React frontend
  api/          Backend/engine clients: engine, ollama, lmstudio, comfyui(+ws/nodes/enum),
                providers/ (openai, anthropic, ollama, lu-cloud…), cloud/ (LU Cloud + Supabase),
                agents/ (agent loop, tool executor, git tools…), mcp/ (MCP tool support),
                rag, trainer, voice, workflows, mlx-*
  components/   React components by feature: chat/, create/, models/, settings/, agents/,
                cloud/, onboarding/, personas/, workflows/, layout/, ui/, three/, …
  hooks/        Custom React hooks (useChat, useCreate, useAgentChat, useCodex, …)
  stores/       Zustand stores (one file per concern, *Store.ts)
  lib/          Framework-free logic: constants, hardware detection, context window math,
                comfy-* helpers, codex-mode, formatters… (heavily unit-tested)
  types/        TypeScript type definitions
src-tauri/      Rust backend (see above)
e2e/            Playwright specs + support/ (tauri-mock.ts, cloud-mock.ts, ui.ts)
scripts/        build-llama.sh (llama.cpp sidecar), release tooling, remote-access smoke tests
.github/workflows/  ci.yml, release.yml, sidecar-windows.yml, mark-old-releases.yml, discord-announce.yml
logos/, public/ Brand assets and web icons
```

Runtime architecture: the frontend talks to the Rust backend via Tauri `invoke()`. All localhost HTTP traffic to engines goes through the Rust command `proxy_localhost` (in production) or the Vite dev middleware `/local-api/*` (in `npm run dev`). `src/api/backend.ts` is the single entry point for these calls.

## Build and test commands

Prerequisites: Node.js ≥ 22 (`.nvmrc` pins 22; `npm ci` for installs), Rust stable. For full desktop dev you also need the llama.cpp sidecar: `bash scripts/build-llama.sh` (needs cmake; on macOS `brew install cmake python@3.12`). `bash scripts/build-llama.sh --check` verifies it.

```bash
npm run tauri:dev      # full desktop dev: hot-reload React + live Rust rebuilds (use for ~95% of work)
npm run dev            # browser-only dev at http://localhost:5173 — fast UI iteration;
                       # Tauri invokes (backendCall, filesystem, updater) do NOT work here
npm run tauri:build    # production installer build → src-tauri/target/release/bundle/

npx tsc --noEmit       # type check (CI gate)
npx vitest run         # unit tests (CI gate)
npm run build          # frontend production build (CI gate)
npm run test:e2e       # Playwright e2e (CI gate); auto-starts the Vite dev server
npm run lint           # eslint — NON-gating, ~170 files of pre-existing debt; keep it red-free for files you touch
cargo check            # in src-tauri/; needs the sidecar file to EXIST (a stub is fine, see ci.yml)
```

Note: `tauri-build` hard-fails if the declared `externalBin` sidecar file is missing. For a plain `cargo check`, create an empty stub: `touch src-tauri/bin/lu-llama-server-$(rustc -vV | awk '/^host:/{print $2}')`.

## Testing strategy

Three layers, all run in CI (`.github/workflows/ci.yml`, on push/PR to `master`):

1. **Vitest unit tests** — `npx vitest run`. Config in `vitest.config.ts`: `globals: true`, node environment, includes only `src/**/__tests__/**/*.test.ts`. Co-locate tests in a `__tests__/` directory next to the code they cover (`src/api/__tests__/`, `src/lib/__tests__/`, `src/stores/__tests__/`, …). ~430 test files exist — match their style. Files ending `.live.test.ts` hit real external services; don't add new ones casually.
2. **Playwright e2e** — `npm run test:e2e` (specs in `e2e/*.spec.ts`). The harness stubs the Tauri IPC in-page via `e2e/support/tauri-mock.ts` (injects `window.__TAURI_INTERNALS__`), so **no Rust sidecar, Ollama, or ComfyUI is needed**. Chromium only, single worker, 60 s timeout. The webServer is `npm run dev` on port 5173.
3. **Rust tests** — 545 `#[test]`s across 30 files in `src-tauri/src/` (unit tests embedded in modules). CI runs `cargo check` on Ubuntu + Windows; run `cargo test` locally in `src-tauri/` when changing Rust code.

CI matrix: lint-and-build (Ubuntu), e2e (Ubuntu), cargo-check (Ubuntu + Windows). Third-party GitHub Actions are **pinned to full commit SHAs** — keep that convention when editing workflows.

## Code style guidelines

From `CONTRIBUTING.md` and observed practice:

- **TypeScript strict mode** — no `any` unless absolutely necessary; `npx tsc --noEmit` must pass.
- **Functional components only** (no classes); one component per file, filename matches component name.
- **Named exports** preferred over default exports.
- **Tailwind utility classes** — avoid custom CSS where possible.
- Extract reusable logic into custom hooks (`src/hooks/`) or framework-free modules (`src/lib/`) rather than leaving it in components.
- ESLint flat config (`eslint.config.js`): typescript-eslint recommended + react-hooks + react-refresh. Lint is historically red and non-gating, but do not add new violations.
- Commit messages: short, descriptive, imperative ("Fix persona selection on new chat") — no conventional-commits requirement.
- Comments in this codebase are unusually verbose and explain **why** (bug IDs, version numbers, reporter names, upstream issue links). When fixing a bug, matching that style is welcome; don't strip existing explanatory comments.
- Language: English throughout (code, comments, docs).

## Deployment / release process

- Releases are built by `.github/workflows/release.yml` on a published GitHub release (or manual dispatch): Ubuntu 22.04 + Windows lanes, each building the llama.cpp sidecar first (cached on the hash of `scripts/build-llama.sh` × target triple, with a pinned Vulkan SDK for GGML_VULKAN builds), then `tauri-action` produces signed installers and updater artifacts.
- `sidecar-windows.yml` pre-builds the Windows sidecar; `mark-old-releases.yml` + `scripts/mark-old-releases.mjs` manage release visibility; `scripts/enforce-prerelease.mjs` and `scripts/release-rules.mjs` encode release-channel rules.
- Auto-update: Tauri updater plugin, endpoint `…/releases/latest/download/latest.json`, artifacts signed with a minisign key (public key in `src-tauri/tauri.conf.json`).
- Per-platform Tauri config overrides: `src-tauri/tauri.{windows,macos,linux}.conf.json`.
- Version is kept in sync across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` — bump all three.

## Security considerations

Take these seriously — the app intentionally runs uncensored local models and executes agent tool calls on the user's machine:

- **CSP** is defined in `src-tauri/tauri.conf.json` with an explicit allowlist of cloud/media hosts. If you add a new external host, update the CSP and the CSP unit tests (`src/api/__tests__/csp-*.test.ts`).
- **SSRF guards**: any user-supplied URL fetched server-side must go through `validate_public_url` in `src-tauri/src/commands/proxy.rs` (production) and the parity guard in `vite.config.ts` (dev server). Never fetch arbitrary URLs without them.
- **Secrets**: provider API keys live in the OS keychain via `src-tauri/src/commands/secret.rs` (Windows Credential Manager / macOS Keychain). Linux deliberately falls back to obfuscated localStorage. The `insecure-test-keychain` Cargo feature must never ship.
- **XSS in chat**: model output is rendered as Markdown/HTML — treat it as untrusted.
- **Path traversal / filesystem**: agent and file commands must respect the workspace jails (`src/lib/dev-fs-jail.ts` on the dev side, `src-tauri/src/commands/filesystem.rs` on the Rust side).
- **Supply chain**: third-party GitHub Actions pinned by SHA; the app downloads models/binaries from HuggingFace, Civitai, ollama.com — verify hosts against the existing allowlists before adding new download sources.
- Report vulnerabilities privately per `SECURITY.md` (GitHub private advisories or Discord DM) — never in a public issue.

## Significant runtime bugfixes (macOS fork workflow)

**Significant runtime bugfixes** are changes that materially alter what users see in the running app — not docs-only or test-only edits. After fixing locally, follow this lane before calling the fix done:

1. **Check upstream** — read [purpledoubled/locally-uncensored](https://github.com/purpledoubled/locally-uncensored) `master` (or the repo default branch) for related fixes or better approaches.
2. **Integrate upstream when it matters** — if upstream has something important, pull/merge/cherry-pick and resolve conflicts with **line-level conflict resolution**. Do not wholesale overwrite local changes.
3. **Prove the integrated tree ships** — run `make release` from the repo root (signed + notarized `.app` + `.dmg`; do not skip notarization).
4. **Open the built app** — `open release/macos/LU.app` (or the path `make release` prints).

**When our fix is better than upstream:** draft a PR title + body the team could send upstream. Do not open the PR unless a maintainer asked — just leave the draft text (e.g. in a local, untracked `.vibecrafted/JOURNAL.md` or the task summary).

macOS release credentials and artifact layout: see `make help` / `Makefile` (`release/macos/LU.dmg`, versioned DMG, `SHA256SUMS.txt`).

## Public-release hygiene (deprivatize)

This is a standing gate, not a one-time scrub. "We already cleaned it" is not a reason to skip the next pass. Run it before a push, a PR, release notes, or any docs that ship — the same way a runtime bugfix is not done until the macOS lane above has run.

The scanner and its private-term list stay **outside this repo** (the `deprivatize` skill config). Do not commit that list here; the list is itself a map of the private system.

On each pass:

1. Scan the tree. Separate a definite local-environment leak from a judgment call.
2. **Change** only unambiguous leaks: this machine's home paths and private usernames. Replacements are `/Users/tester/...` and `/workspace/...`. No other placeholder style.
3. **Leave** fictional fixtures (`/Users/dave`, `/home/builder`), upstream changelog paths, git authors, remotes, bundle IDs, and the signing identity. A word that is also an English word (`ops`) is not a machine name.
4. **Review** anything that would change a symbol, test contract, URL, or runtime identifier. Write those to `~/.local/state/vetcoders/naming/need-decisions.md`. If it is not in that file, it is not a recorded decision.
5. Do not rewrite git history to finish a scrub.

## Gotchas

- `npm run dev` (browser mode) cannot call the Rust backend — use `npm run tauri:dev` for anything touching engines, files, or updates.
- An external ComfyUI must be started with `--enable-cors-header "*"` for dev; LU's own auto-started instance already is.
- On Linux/Wayland the app forces `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` at boot (see `apply_linux_webkit_workarounds` in `src-tauri/src/main.rs`) — don't remove without reading the linked upstream issues.
- The window starts hidden and frameless/transparent (`tauri.conf.json`); React calls `show_window` after first render (`src/App.tsx`).
- Repo tooling note: `grep`/`rg` via shell are blocked in this workspace — use the dedicated search tools or `loct find`.
- Never `cd src-tauri && loct` / `tauri`. `src-tauri/.loctree` is a sentinel *file* (blocks a nested `.loctree/` dir) but `loct scan` still writes a crate-keyed cache. From `.`: `scripts/assert-loct-repo-root.sh`, or `scripts/bin/loct` on PATH (`mise` prepends it). `make loc` already asserts root. `cargo` uses `--manifest-path src-tauri/Cargo.toml` from `.`.
