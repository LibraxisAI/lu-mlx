import type { Connect } from 'vite'
import type { RouteMount } from './routes'

/**
 * Computer use sees and controls the screen from the Rust process
 * (src-tauri/src/commands/computer.rs). The plain Vite dev server has no Rust
 * process and must never grow a second way to move the mouse, so every
 * computer endpoint answers with an honest HTTP 501 and a sentence. The
 * wrappers in src/api/computer.ts already refuse before they get here; these
 * are the backstop for a caller that goes around them.
 */
export const COMPUTER_STUB_PATHS = [
  '/local-api/computer-status',
  '/local-api/computer-chat-ask',
  '/local-api/computer-chat-answer',
  '/local-api/computer-session-begin',
  '/local-api/computer-session-allow-app',
  '/local-api/computer-session-revoke-app',
  '/local-api/computer-session-set-autonomous',
  '/local-api/computer-session-end',
  '/local-api/computer-stop',
  '/local-api/computer-request-attention',
  '/local-api/computer-guard',
  '/local-api/computer-windows',
  '/local-api/computer-screen',
  '/local-api/computer-action',
  '/local-api/computer-tree',
  '/local-api/computer-permissions',
  '/local-api/computer-permission-request',
  '/local-api/computer-permission-reset',
  '/local-api/computer-pause',
  '/local-api/computer-takeover-answer',
  '/local-api/computer-watch',
  '/local-api/computer-surface',
  '/local-api/computer-surface-corner',
]

export function registerComputerStubs(routes: RouteMount): void {
  const body = JSON.stringify({
    error: 'Computer control needs the installed desktop app. Use `npm run tauri:dev` to run it in development.',
    devModeOnly: true,
    ok: false,
  })
  const stub: Connect.SimpleHandleFunction = (_req, res) => {
    res.writeHead(501, { 'Content-Type': 'application/json' })
    res.end(body)
  }
  for (const path of COMPUTER_STUB_PATHS) routes.use(path, stub)
}
