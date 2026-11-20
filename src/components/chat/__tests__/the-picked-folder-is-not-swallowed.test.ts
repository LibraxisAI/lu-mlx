// @vitest-environment jsdom
/**
 * Bug D, symptom 3. Discord ticket, 2026-09-08, Windows 11,
 * LU 2.6.8, provider Ollama, DESKTOP app, Code tab:
 *
 *   "Error: Not an allowed workspace folder (only a folder you chose in LU's
 *    folder picker can be a workspace, pick it again to allow it): D:\code"
 *
 * for a folder he had picked. Three things in the Code tab's folder button made
 * that a closed loop, and none of them was measured.
 *
 *  1. `system::pick_folder` recorded the folder with `let _ = …`, so a folder
 *     the allowlist refuses came back as `Ok(Some(path))` with the reason
 *     thrown away. The panel put it in the header as the working directory, and
 *     every file op under it answered with the sentence above.
 *  2. The panel fell back to `window.prompt('Enter folder path:')` whenever the
 *     bridge call threw. A folder joins the allowlist through the NATIVE dialog
 *     and nowhere else, so a typed path was a workspace that could never work
 *     in the packaged app, and the way out of the error was the same prompt.
 *     (In the dev server's browser there is no allowlist at all, so the prompt
 *     is the intended mechanism there and stays.)
 *  3. `check_workspace_root` asked the allowlist BEFORE the structural gate, so
 *     folders no pick can ever allow ($HOME, `C:\Users`, anything under
 *     `AppData`) were also told to "pick it again", which is the one action
 *     that cannot help.
 *
 * Source-level assertions, because `vitest.config.ts` runs environment 'node'
 * and there is no renderer. The MESSAGE is checked for real, it is a pure
 * function. Same split as
 * src/components/layout/__tests__/der-abgelehnte-ordner-wird-nicht-verschluckt.test.ts,
 * which pins the same repair on the Remote-dispatch picker.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-picked-folder-is-not-swallowed.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
// Loaded with the file and not inside a test: the first load of the panel's
// module graph took 6.3 s on a loaded machine, more than the five seconds a
// test has (both panel tests red in a full run on 09.10.2026).
import * as backend from '../../../api/backend'
import { useCodexStore } from '../../../stores/codexStore'
import { ExplorerPanel } from '../ExplorerPanel'
import { workspacePickRefusedMessage } from '../../../lib/workspace-rejected'

const src = (...parts: string[]) => readFileSync(resolve(__dirname, '..', '..', '..', ...parts), 'utf8')

/** The body of `pickFolder` in the explorer panel, braces counted. */
function pickFolderBody(): string {
  const raw = src('components', 'chat', 'ExplorerPanel.tsx')
  const at = raw.indexOf('const pickFolder')
  expect(at, 'the folder button lost its handler').toBeGreaterThan(0)
  const open = raw.indexOf('{', raw.indexOf('=>', at))
  let depth = 0
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === '{') depth++
    else if (raw[i] === '}') {
      depth--
      if (depth === 0) return raw.slice(open, i + 1)
    }
  }
  return raw.slice(open)
}

describe('the Code tab folder button', () => {
  it('asks for the folder AS A WORKSPACE, so a refusal comes back', () => {
    const body = pickFolderBody()
    expect(body, 'pick_folder is called without asWorkspace').toContain('asWorkspace: true')
  })

  it('never offers a typed path as a FALLBACK, because it can never be allowed', () => {
    const body = pickFolderBody()
    // The prompt itself may stay: `npm run dev` in a browser has no native
    // dialog and no allowlist either (lib/dev-fs-jail.ts says why), so a typed
    // path is the intended mechanism THERE. What must never come back is the
    // prompt as the answer to a failed bridge call, where the typed path lands
    // in the header and can then never be a workspace.
    const prompts = body.match(/window\.prompt\(/g) ?? []
    expect(prompts.length, 'more than the one dev-server prompt').toBeLessThanOrEqual(1)
    const tryAt = body.indexOf('try {')
    expect(tryAt, 'the bridge call is not guarded at all').toBeGreaterThan(0)
    expect(body.slice(tryAt), 'the window.prompt fallback is back').not.toContain('window.prompt')
    expect(body.indexOf('window.prompt'), 'the prompt is not in the no-bridge branch')
      .toBeLessThan(tryAt === -1 ? Number.MAX_SAFE_INTEGER : tryAt)
  })

  it('a refused folder is reported and NOT set as the working directory', () => {
    const body = pickFolderBody()
    expect(body, 'the refusal never reaches the user').toContain('workspacePickRefusedMessage')
    // The property that matters: nothing in the catch writes the folder. A
    // `setWorkingDirectory` there would put the refused folder into the header
    // anyway, and every file op under it would then answer with the sentence
    // the user was just told to act on.
    const catchAt = body.indexOf('} catch')
    expect(catchAt, 'the refusal is not caught at all').toBeGreaterThan(0)
    expect(body.slice(catchAt), 'the refused folder still lands in the header')
      .not.toContain('setWorkingDirectory(')
  })
})

describe('the native dialog reports what it refused to record', () => {
  it('pick_folder no longer discards the recording result', () => {
    const rust = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'src-tauri', 'src', 'commands', 'system.rs'),
      'utf8',
    )
    const at = rust.indexOf('pub async fn pick_folder')
    expect(at, 'pick_folder is gone').toBeGreaterThan(0)
    const body = rust.slice(at, at + 1200)
    expect(body, 'the reason is discarded again').not.toMatch(/let _ = .*remember_picked_root/)
    expect(body, 'as_workspace does not gate the refusal').toContain('as_workspace')
  })

  it('the structural gate decides the MESSAGE before the allowlist does', () => {
    const rust = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'src-tauri', 'src', 'commands', 'filesystem.rs'),
      'utf8',
    )
    const at = rust.indexOf('fn check_workspace_root')
    expect(at, 'check_workspace_root is gone').toBeGreaterThan(0)
    const body = rust.slice(at, rust.indexOf('\n}', at))
    const gate = body.indexOf('may_be_a_picked_root')
    const list = body.indexOf('PICKED_ROOTS')
    expect(gate, 'the structural gate is gone').toBeGreaterThan(0)
    expect(list, 'the allowlist is gone').toBeGreaterThan(0)
    expect(gate, 'a folder no pick can allow is still told to pick it again').toBeLessThan(list)
  })
})

describe('the sentence the user reads', () => {
  it('carries the real reason and says the folder was not taken', () => {
    const satz = workspacePickRefusedMessage(new Error('a home or mount container is not a workspace'))
    expect(satz).toContain('a home or mount container is not a workspace')
    expect(satz).toContain('not taken')
  })

  it('survives a thrown plain string instead of an Error', () => {
    expect(workspacePickRefusedMessage('system or credential directory')).toContain(
      'system or credential directory',
    )
    expect(workspacePickRefusedMessage('x')).not.toContain('undefined')
  })

  it('never tells the user to do the thing that cannot work', () => {
    const satz = workspacePickRefusedMessage(new Error('system or credential directory'))
    expect(satz.toLowerCase(), 'the closed loop is back').not.toContain('pick it again')
  })
})

/**
 * R2-15 und R2-16: der vierte Weg, auf dem derselbe Satz verschwand.
 *
 * Die Fehlerzeile der Baumspalte stand HINTER dem leeren Zustand. Wird ein
 * Ordner abgelehnt, bleibt `workingDirectory` leer, also gewann "No folder
 * picked." und der Grund verschwand ungelesen. Der Nutzer sah einen Klick, der
 * nichts tat, und genau den Satz, der ihm haette sagen koennen warum, bekam er
 * nie zu sehen.
 *
 * Gemessen statt gelesen, also jsdom. Die Ablehnung kommt aus der Bruecke, und
 * V2a hat gemessen, dass die Gegenprobe einen Vorlauf braucht, bis der
 * abgewiesene Aufruf im Zustand angekommen ist (R2-43).
 */
describe('die Ablehnung im leeren Zustand', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('steht im Rumpf, statt vom leeren Zustand verdeckt zu werden', async () => {
    vi.spyOn(backend, 'isTauri').mockReturnValue(true)
    vi.spyOn(backend, 'backendCall').mockImplementation(async (cmd: string) => {
      if (cmd === 'pick_folder') throw new Error('a home or mount container is not a workspace')
      return null as never
    })
    useCodexStore.setState({ workingDirectory: '' })

    render(createElement(ExplorerPanel, { onApprovePlan: () => {} }))
    expect(screen.queryByTestId('explorer-no-folder'), 'ohne Klick steht der leere Zustand da')
      .not.toBeNull()

    fireEvent.click(screen.getByTestId('explorer-pick-folder'))

    // Bis die Ablehnung da ist, nicht eine feste Zeit lang.
    const fehler = await screen.findByTestId('explorer-error')
    expect(fehler.textContent).toContain('a home or mount container is not a workspace')
    expect(screen.queryByTestId('explorer-no-folder'), 'der leere Zustand verdeckt den Grund')
      .toBeNull()
  })

  it('R2-43: survives a later, unrelated successful load of the still-valid root', async () => {
    vi.spyOn(backend, 'isTauri').mockReturnValue(true)
    vi.spyOn(backend, 'backendCall').mockImplementation(async (cmd: string) => {
      if (cmd === 'pick_folder') throw new Error('a home or mount container is not a workspace')
      if (cmd === 'fs_list') return { entries: [], truncated: false } as never
      return null as never
    })
    // A root that keeps loading fine on its own, unrelated to the refused pick.
    useCodexStore.setState({ workingDirectory: '/Users/x/existing-project' })

    const fsList = () => vi.mocked(backend.backendCall).mock.calls.filter(([cmd]) => cmd === 'fs_list').length
    render(createElement(ExplorerPanel, { onApprovePlan: () => {} }))
    // The root has loaded once before anything is picked.
    await waitFor(() => expect(fsList()).toBeGreaterThan(0))

    fireEvent.click(screen.getByTestId('explorer-pick-folder'))
    expect((await screen.findByTestId('explorer-error')).textContent)
      .toContain('a home or mount container is not a workspace')

    // The agent writes a file: fileTreeVersion bumps, the (unchanged, valid)
    // root reloads and succeeds. The refusal must still be on screen.
    const before = fsList()
    act(() => { useCodexStore.getState().bumpFileTreeVersion() })
    await waitFor(() => expect(fsList()).toBeGreaterThan(before))
    // One turn of the event loop: the answer of that reload has been taken
    // in and rendered, however many steps it takes. Not a wait on the clock.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const fehler = screen.queryByTestId('explorer-error')
    expect(fehler, 'a harmless reload of the root wiped the refusal').not.toBeNull()
    expect(fehler!.textContent).toContain('a home or mount container is not a workspace')
  })
})
