/**
 * @vitest-environment jsdom
 *
 * box-gruen/n9 Punkt 87 (ENG-18): "Update ComfyUI" used to call
 * `runUpdate()` the instant it was clicked -- no confirmation, and no lock
 * against a ComfyUI already on the port, own or foreign. The real damage on
 * the Windows box: a foreign ComfyUI read as plain "Running", the click
 * started "Installing ComfyUI..." anyway, and a Cancel taken 1-2 seconds
 * later left a pulled core with an unfinished venv
 * (`ModuleNotFoundError: No module named 'comfy_aimdo.storage'`).
 *
 * This mounts the real panel and checks the house-pattern dialog (same shape
 * as `TrainerReinstallModal`): it appears on click, Escape and the X both
 * close it without calling the backend, and only the dialog's own Update
 * button calls `update_comfyui`. Separately, a ComfyUI this app did not
 * start blocks the click before the dialog even opens.
 *
 * Final review 19.09.2026 added two more cases: `ownedByApp` (not
 * `processAlive`, which lies about LU's own ComfyUI after an app restart,
 * B2) decides ownership, the dialog text says LU stops its own ComfyUI
 * first (B4), and a fast double click on the dialog's own Update button
 * fires the backend only once (K2).
 *
 * Run: npx vitest run src/components/settings/__tests__/comfy-update-confirm-dialog.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
  setComfyPort: vi.fn(),
  setComfyHost: vi.fn(),
}))

const { ComfyUISettings } = await import('../SettingsPage')
const { useComfyInstallStore } = await import('../../../stores/comfyInstallStore')

/** What `comfyui_status` answers next. Own, idle ComfyUI by default. */
let comfyStatus: Record<string, unknown> = {
  running: false, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: false,
}

beforeEach(() => {
  useComfyInstallStore.getState().reset()
  comfyStatus = { running: false, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: false }
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfyui_status') return comfyStatus
    if (cmd === 'update_comfyui') return { status: 'installing' }
    if (cmd === 'install_comfyui_status') return { status: 'installing', logs: ['Updating ComfyUI...'] }
    return {}
  })
})
afterEach(() => { cleanup(); useComfyInstallStore.getState().reset() })

async function mountPanel() {
  render(createElement(ComfyUISettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('the Update ComfyUI confirmation dialog', () => {
  it('does not call the backend on a bare click, only opens the dialog', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    expect(screen.getByRole('dialog', { name: /Update ComfyUI\?/ })).toBeTruthy()
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(false)
  })

  it('names the folder as read-only text and says LU stops its own ComfyUI first (B4)', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    // B4: the old wording ("ComfyUI must not be running") hid the fact that
    // LU itself kills a running, own ComfyUI as part of the update.
    expect(screen.getByText(/it will be stopped first/)).toBeTruthy()
    expect(screen.getByText(/C:\\ComfyUI/)).toBeTruthy()
    // Read-only: no textbox for the folder, unlike the Path field above it.
    expect(screen.queryByRole('textbox', { name: /ComfyUI folder/ })).toBeNull()
  })

  it('Escape closes the dialog without calling the backend', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })
    expect(screen.getByRole('dialog', { name: /Update ComfyUI\?/ })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Update ComfyUI\?/ })).toBeNull())
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(false)
  })

  it('the X closes the dialog without calling the backend', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Update ComfyUI\?/ })).toBeNull())
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(false)
  })

  it('the Cancel button in the dialog closes it without calling the backend', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Update ComfyUI\?/ })).toBeNull())
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(false)
  })

  it('only the dialog Update button calls update_comfyui, and only once confirmed', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Update ComfyUI\?/ })).toBeNull())
  })

  it('K2: two fast clicks on the dialog Update button call the backend only once', async () => {
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    const updateButton = screen.getByRole('button', { name: 'Update' })
    // Both clicks fire before any state update is flushed, exactly the race
    // the ref guard in `handleConfirmUpdate` exists to close.
    fireEvent.click(updateButton)
    fireEvent.click(updateButton)

    await waitFor(() => expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(true))
    expect(backendCall.mock.calls.filter(([cmd]) => cmd === 'update_comfyui').length).toBe(1)
  })
})

describe('R3-1 (final review Runde 3): the running-instance guard refuses through install_status, not a thrown error', () => {
  // The guard (`ensure_comfyui_stopped_for_update`) moved off the Rust
  // command's own synchronous return and into the worker thread it already
  // spawns, so `update_comfyui` now resolves normally even when the guard
  // is about to refuse -- the refusal only shows up on the next
  // `install_comfyui_status` poll (comfyInstallStore's `POLL_MS`, 2000ms).
  // This proves the panel still shows the exact same English wording
  // through that channel, and does not depend on a synchronous throw
  // anywhere in this test.
  afterEach(() => { vi.useRealTimers() })

  it('shows the guard\'s exact wording once the next poll reports it, though update_comfyui itself resolved', async () => {
    const guardMessage =
      'ComfyUI is generating something right now. Wait for it to finish, or stop the render ' +
      'yourself, then run Update ComfyUI again. Nothing was changed.'
    comfyStatus = { running: true, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: true }
    let pollCount = 0
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'comfyui_status') return comfyStatus
      // The Rust side no longer throws for this refusal -- it now reports
      // through install_status from inside the worker thread instead.
      if (cmd === 'update_comfyui') return { status: 'installing' }
      if (cmd === 'install_comfyui_status') {
        pollCount += 1
        if (pollCount === 1) return { status: 'installing', logs: ['Updating ComfyUI...'] }
        return { status: 'error', logs: ['Updating ComfyUI...', guardMessage] }
      }
      return {}
    })

    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })) })

    // update_comfyui resolved without throwing, and the poll's first tick
    // still reads "installing": nothing has failed yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(pollCount).toBe(1)
    expect(useComfyInstallStore.getState().phase).not.toBe('error')

    // The second tick is the one that lands the guard's refusal.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(useComfyInstallStore.getState().phase).toBe('error')
    expect(useComfyInstallStore.getState().error).toContain(guardMessage)
    // Shows up twice on screen (the raw log line and the framed error
    // paragraph both carry it) -- either is proof the panel, not just the
    // store, renders the guard's exact wording.
    expect(screen.getAllByText(/ComfyUI is generating something right now/).length).toBeGreaterThan(0)
  })

  it('GEGENPROBE: without a later error poll, the same run just completes, proving the test above actually exercises the error tick', async () => {
    comfyStatus = { running: true, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: true }
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'comfyui_status') return comfyStatus
      if (cmd === 'update_comfyui') return { status: 'installing' }
      if (cmd === 'install_comfyui_status') return { status: 'complete', logs: ['Updating ComfyUI...'] }
      return {}
    })

    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(useComfyInstallStore.getState().phase).toBe('idle')
    expect(useComfyInstallStore.getState().error).toBe('')
  })
})

describe('R4-1 (final review Runde 4): a stale status from an earlier run must not survive into this one', () => {
  // `install_status` on the Rust side is never reset to "idle" on its own --
  // it just carries whatever the LAST install/repair/update run left in it
  // (`complete`, `error`, or `cancelled`) until something overwrites it. The
  // running-instance guard added in R3-1 can now take up to 13s
  // (R2-1/R2-2) before the worker thread writes its own first status, so the
  // panel's first poll (2s after the click, comfyInstallStore's `POLL_MS`)
  // used to land squarely on that stale leftover and read it as THIS run's
  // own outcome: a leftover "complete" ended the poll right there with
  // "Update finished", and a refusal the guard produced moments later was
  // never shown because nothing was watching anymore. The fix resets the
  // slot to "idle" on the CALLER's thread, before the worker thread (and
  // its guard) even starts, so the very first poll can only ever see "idle"
  // or the worker's own progress -- never a stale terminal state from a run
  // that has nothing to do with this one.
  afterEach(() => { vi.useRealTimers() })

  it('an old "complete" from an earlier run is gone by the time the first poll runs, and a later refusal still shows through', async () => {
    const guardMessage =
      'ComfyUI is generating something right now. Wait for it to finish, or stop the render ' +
      'yourself, then run Update ComfyUI again. Nothing was changed.'
    comfyStatus = { running: true, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: true }

    // What a run from earlier in the session left behind -- exactly what
    // `install_comfyui_status` would still answer the instant before this
    // click, if the Rust side did not reset it.
    let installStatus: Record<string, unknown> = {
      status: 'complete',
      logs: ['Update finished. ComfyUI is starting again with the new nodes.'],
    }
    let pollsSinceUpdateClicked = 0
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'comfyui_status') return comfyStatus
      if (cmd === 'update_comfyui') {
        // The real Rust command resets install_status to "idle" on the
        // caller's thread before it ever returns (R4-1's fix) -- so by the
        // time this promise resolves, the stale "complete" above is
        // already gone, well before the guard's own wait even starts.
        installStatus = { status: 'idle', logs: [] }
        return { status: 'installing' }
      }
      if (cmd === 'install_comfyui_status') {
        pollsSinceUpdateClicked += 1
        // The guard's refusal, landing on the second poll -- it could just
        // as well take longer (up to 13s), the point here is only that it
        // is never masked by the stale value from before this run.
        if (pollsSinceUpdateClicked >= 2) {
          installStatus = { status: 'error', logs: ['Updating ComfyUI...', guardMessage] }
        }
        return installStatus
      }
      return {}
    })

    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })) })

    // First poll: the reset already landed, so this reads "idle", never
    // the stale "complete" -- the run must not read as already finished.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(useComfyInstallStore.getState().phase).toBe('comfyui')
    expect(useComfyInstallStore.getState().notice).toBe('')

    // Second poll: the worker's own refusal, still watched for because
    // nothing stopped the poll on the way here.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(useComfyInstallStore.getState().phase).toBe('error')
    expect(useComfyInstallStore.getState().error).toContain(guardMessage)
  })

  it('GEGENPROBE: without the reset, the stale "complete" reads as this run finishing, and the later refusal is never seen', async () => {
    // Same backend sequence as above, EXCEPT update_comfyui no longer
    // performs the reset -- exactly the pre-fix behaviour. This is the bug
    // R4-1 describes: proves the test above is not vacuously green, and
    // documents why the reset has to happen on the Rust side at all (the
    // store cannot recover from this on its own -- a `complete` poll stops
    // the timer for good, so a real refusal one tick later would never be
    // seen either way).
    const guardMessage =
      'ComfyUI is generating something right now. Wait for it to finish, or stop the render ' +
      'yourself, then run Update ComfyUI again. Nothing was changed.'
    comfyStatus = { running: true, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: true }

    let installStatus: Record<string, unknown> = {
      status: 'complete',
      logs: ['Update finished. ComfyUI is starting again with the new nodes.'],
    }
    let pollsSinceUpdateClicked = 0
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'comfyui_status') return comfyStatus
      // No reset here -- the stale "complete" from before this run survives.
      if (cmd === 'update_comfyui') return { status: 'installing' }
      if (cmd === 'install_comfyui_status') {
        pollsSinceUpdateClicked += 1
        if (pollsSinceUpdateClicked >= 2) {
          installStatus = { status: 'error', logs: ['Updating ComfyUI...', guardMessage] }
        }
        return installStatus
      }
      return {}
    })

    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPanel()
    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })) })

    // The first poll already reads the stale "complete" and stops watching.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(useComfyInstallStore.getState().phase).toBe('idle')

    // The refusal that would have landed on the next tick is never seen.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(useComfyInstallStore.getState().phase).toBe('idle')
    expect(useComfyInstallStore.getState().error).toBe('')
  })
})

describe('a ComfyUI this app did not start blocks the click, negative control included', () => {
  it('a foreign, running ComfyUI shows a message instead of opening the dialog', async () => {
    comfyStatus = { running: true, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: false }
    await mountPanel()

    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    expect(screen.queryByRole('dialog', { name: /Update ComfyUI\?/ })).toBeNull()
    expect(screen.getByText(/did not start is using this folder/)).toBeTruthy()
    expect(backendCall.mock.calls.some(([cmd]) => cmd === 'update_comfyui')).toBe(false)
    // The status line itself says so too (ownedByApp: false while running).
    expect(screen.getByText('Running (started outside LU)')).toBeTruthy()
  })

  it('GEGENPROBE: the app\'s own running ComfyUI opens the dialog like any other case', async () => {
    // Negative control for the guard above: same `running: true`, but this
    // time the backend says it is ours.
    comfyStatus = { running: true, found: true, complete: true, path: 'C:\\ComfyUI', isLocal: true, ownedByApp: true }
    await mountPanel()

    await act(async () => { fireEvent.click(screen.getByText('Update ComfyUI')) })

    expect(screen.getByRole('dialog', { name: /Update ComfyUI\?/ })).toBeTruthy()
    expect(screen.queryByText(/did not start is using this folder/)).toBeNull()
    expect(screen.getByText('Running')).toBeTruthy()
    // Final review 19.09.2026, B2: `ownedByApp: true` is exactly the answer
    // the backend now gives for BOTH a live handle from this run AND an
    // orphan adopted from an earlier one (`find_orphaned_comfyui`) -- the
    // frontend cannot and must not tell those two apart on its own, it only
    // reads the one shared verdict. The Rust-side distinction itself is
    // proven in `process.rs`'s `comfy_adoption_tests` (`classify_comfyui_ownership`).
    expect(screen.queryByText('Running (started outside LU)')).toBeNull()
  })
})
