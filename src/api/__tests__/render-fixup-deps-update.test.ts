/**
 * The update a render asked for (lib/render-fixups.ts): the update itself
 * brings ComfyUI back up (update_comfyui in Rust starts it before it reports
 * complete), so the render only waits for the port and goes on. It never
 * needed a click on Start, and it does not start a second copy.
 *
 * Run: npx vitest run src/api/__tests__/render-fixup-deps-update.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backendCall = vi.fn()
const checkComfyConnection = vi.fn()
const install = vi.hoisted(() => ({
  state: { phase: 'idle', logs: [] as string[], error: '', runUpdate: async () => undefined },
}))

vi.mock('../backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  backendCall: (...a: unknown[]) => backendCall(...a),
}))
vi.mock('../comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: (...a: unknown[]) => checkComfyConnection(...a),
}))
vi.mock('../../stores/comfyInstallStore', () => ({
  useComfyInstallStore: { getState: () => install.state },
}))

import { renderFixupDeps } from '../render-fixup-deps'

beforeEach(() => {
  vi.useFakeTimers()
  backendCall.mockReset()
  checkComfyConnection.mockReset()
  install.state = { phase: 'idle', logs: [], error: '', runUpdate: async () => undefined }
})
afterEach(() => { vi.useRealTimers() })

describe('the update a render asked for', () => {
  it('goes on as soon as the updated ComfyUI answers, without starting it a second time', async () => {
    const lines: string[] = []
    // Still importing on the first two probes, then up.
    checkComfyConnection.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
    install.state.runUpdate = async () => { install.state.phase = 'comfyui'; install.state.logs = ['Step 1/3: Pulling the latest ComfyUI...'] }
    const done = renderFixupDeps((line) => lines.push(line)).updateComfy()
    await vi.advanceTimersByTimeAsync(2000)
    expect(lines).toContain('Step 1/3: Pulling the latest ComfyUI...')
    install.state.phase = 'idle'
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(done).resolves.toBeUndefined()
    expect(checkComfyConnection).toHaveBeenCalledTimes(3)
    expect(backendCall.mock.calls.map((c) => c[0])).not.toContain('start_comfyui')
  })

  it('an update that failed ends the run with its reason', async () => {
    install.state.runUpdate = async () => { install.state.phase = 'error'; install.state.error = 'Updating ComfyUI did not finish. git pull failed.' }
    const done = renderFixupDeps(() => undefined).updateComfy()
    const failed = expect(done).rejects.toThrow('Updating ComfyUI did not finish. git pull failed.')
    await vi.advanceTimersByTimeAsync(2000)
    await failed
    expect(checkComfyConnection).not.toHaveBeenCalled()
  })

  it('a ComfyUI that never comes back is said, with where to start it', async () => {
    checkComfyConnection.mockResolvedValue(false)
    const done = renderFixupDeps(() => undefined).updateComfy()
    const failed = expect(done).rejects.toThrow('ComfyUI was updated but did not come back up. Start it from Settings and hit Create again.')
    await vi.advanceTimersByTimeAsync(200_000)
    await failed
  })
})
