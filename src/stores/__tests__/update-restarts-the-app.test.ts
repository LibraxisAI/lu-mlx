/**
 * "Restart Now" has to bring the app back.
 *
 * GitHub discussion 150, 2026-10-03: the update says the app restarts, the app
 * closes, and the user starts it by hand. Read against the plugin, the store
 * had no restart in it at all. On Windows nobody noticed for the code's sake,
 * because there `install()` never returns: the plugin starts the NSIS
 * installer with `/R` and ends the process, and the installer starts the new
 * version. On macOS and Linux `install()` returns into the old process, and
 * the only thing that followed was `exit_app`.
 *
 * So the plugin lane now ends in `restart_after_update`, which starts the new
 * version and then leaves. The lane where LU installs itself keeps its plain
 * exit: `self_migrate_finish` has already started the new AppImage there, and
 * a second start would only meet single instance.
 *
 * Run: npx vitest run src/stores/__tests__/update-restarts-the-app.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []
const platform = { linux: false }
const backend = {
  /** Commands that reject, as an older or broken backend would. */
  rejects: new Set<string>(),
  installMethod: null as null | { kind: string; exe_path: string; writable: boolean },
}

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isLinux: () => platform.linux,
  isMacOS: () => !platform.linux,
  openExternal: vi.fn(),
  backendCall: vi.fn(async (cmd: string) => {
    calls.push(`backend:${cmd}`)
    if (backend.rejects.has(cmd)) throw new Error(`${cmd} failed`)
    if (cmd === 'install_method') return backend.installMethod
    if (cmd === 'self_migrate_stage') return { version: '2.6.6' }
    return null
  }),
}))

vi.mock('../../api/engine', () => ({
  stopBundledEngine: vi.fn(async () => {}),
  stopBundledEmbed: vi.fn(async () => {}),
}))

vi.mock('../../../package.json', () => ({ version: '2.6.5' }))

const install = vi.fn(async () => {
  calls.push('install')
})

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => ({ version: '2.6.6', body: 'notes', install, download: vi.fn() })),
}))

import { useUpdateStore, resetUpdateSession } from '../updateStore'

describe('Restart Now brings the app back', () => {
  beforeEach(() => {
    calls.length = 0
    install.mockClear()
    platform.linux = false
    backend.rejects.clear()
    backend.installMethod = null
    resetUpdateSession()
    useUpdateStore.setState({
      downloadStatus: 'downloaded',
      autoDownload: false,
      lastChecked: null,
      latestVersion: null,
      updateAvailable: false,
      errorMessage: null,
      installMethod: null,
    })
  })

  it('asks for the restart once the plugin has put the new files in place', async () => {
    await useUpdateStore.getState().checkForUpdate(true)
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(calls.indexOf('install')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('install')).toBeLessThan(calls.indexOf('backend:restart_after_update'))
    // The restart command leaves on its own. A plain exit next to it would
    // race the start of the new version.
    expect(calls).not.toContain('backend:exit_app')
    expect(useUpdateStore.getState().downloadStatus).not.toBe('error')
  })

  it('still closes when the restart cannot be asked for', async () => {
    // The files are replaced at this point. A window that stays open on the
    // old build, with an error about an install that worked, would be worse
    // than the old behaviour.
    backend.rejects.add('restart_after_update')
    await useUpdateStore.getState().checkForUpdate(true)
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(calls).toContain('backend:restart_after_update')
    expect(calls.indexOf('backend:restart_after_update')).toBeLessThan(calls.indexOf('backend:exit_app'))
    expect(useUpdateStore.getState().downloadStatus).not.toBe('error')
  })

  it('never restarts after an install that failed', async () => {
    install.mockRejectedValueOnce(new Error('pkexec was dismissed'))
    await useUpdateStore.getState().checkForUpdate(true)
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(calls).not.toContain('backend:restart_after_update')
    expect(calls).not.toContain('backend:exit_app')
    expect(useUpdateStore.getState().downloadStatus).toBe('error')
  })

  it('leaves the lane where LU installs itself on its plain exit', async () => {
    // self_migrate_finish has started the new AppImage already.
    platform.linux = true
    backend.installMethod = { kind: 'pacman', exe_path: '/usr/bin/locally-uncensored', writable: false }
    await useUpdateStore.getState().checkForUpdate(true)
    await useUpdateStore.getState().downloadUpdate()
    calls.length = 0

    await useUpdateStore.getState().installAndRestart()

    expect(install).not.toHaveBeenCalled()
    expect(calls.indexOf('backend:self_migrate_finish')).toBeLessThan(calls.indexOf('backend:exit_app'))
    expect(calls).not.toContain('backend:restart_after_update')
  })
})
