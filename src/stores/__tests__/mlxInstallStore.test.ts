/**
 * The download tray's window into the Rust MLX install slots (2026-07-31)
 *
 * The owner: a 2.6 GB model pull showed only a spinning "Installing…" button; the
 * titlebar download tray never listed it. This store is the tray's view of the
 * four Rust install slots. These tests pin the lifecycle: watch() follows a
 * slot to its terminal state and stops polling, 'idle' means the app restarted
 * under us (entry dismissed), a failed poll is transient and must not kill the
 * watch, and adopt() picks up exactly the installs nobody is watching.
 *
 * Run: npx vitest run src/stores/__tests__/mlxInstallStore.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getMlxImageEngineStatus = vi.fn()
const getMlxImageInstallStatus = vi.fn()
const getMlxInstallStatus = vi.fn()
const getModelInstallStatus = vi.fn()
const cancelMlxImageInstall = vi.fn()
const cancelVideoModelInstall = vi.fn()

vi.mock('../../api/mlx-image', () => ({
  getMlxImageEngineStatus: (...a: unknown[]) => getMlxImageEngineStatus(...(a as [])),
  getMlxImageInstallStatus: (...a: unknown[]) => getMlxImageInstallStatus(...(a as [])),
  cancelMlxImageInstall: (...a: unknown[]) => cancelMlxImageInstall(...(a as [])),
}))
vi.mock('../../api/mlx-video', () => ({
  getMlxInstallStatus: (...a: unknown[]) => getMlxInstallStatus(...(a as [])),
  getModelInstallStatus: (...a: unknown[]) => getModelInstallStatus(...(a as [])),
  cancelVideoModelInstall: (...a: unknown[]) => cancelVideoModelInstall(...(a as [])),
}))

import { useMlxInstallStore, mlxLaneGeneration, mlxInstallLane, resetMlxInstallStoreForTest } from '../mlxInstallStore'

function slot(over: Record<string, unknown> = {}) {
  return {
    status: 'installing',
    logs: [] as string[],
    error: null,
    download_progress: 0,
    download_total: 0,
    download_speed: 0,
    ...over,
  }
}

// The immediate tick in watch() is pure microtasks, no timer advance needed.
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const entries = () => useMlxInstallStore.getState().entries

describe('mlxInstallStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    resetMlxInstallStoreForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows an install to complete and stops polling', async () => {
    getMlxImageInstallStatus
      .mockResolvedValueOnce(
        slot({ download_progress: 500, download_total: 1000, download_speed: 42, logs: ['pulling weights'] }),
      )
      .mockResolvedValueOnce(slot({ status: 'complete', download_progress: 1000, download_total: 1000 }))

    useMlxInstallStore.getState().watch('image-model', 'SD Turbo')
    expect(entries()['image-model']).toMatchObject({ status: 'installing', label: 'SD Turbo' })

    await flush()
    expect(entries()['image-model']).toMatchObject({
      progress: 500,
      total: 1000,
      speed: 42,
      lastLog: 'pulling weights',
    })

    await vi.advanceTimersByTimeAsync(1200)
    expect(entries()['image-model']).toMatchObject({ status: 'complete', progress: 1000 })

    const calls = getMlxImageInstallStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(getMlxImageInstallStatus.mock.calls.length).toBe(calls)
  })

  it('keeps an errored install visible with its cause and stops polling', async () => {
    getModelInstallStatus.mockResolvedValueOnce(slot({ status: 'error', error: 'disk full' }))

    useMlxInstallStore.getState().watch('video-model', 'Wan 2.1')
    await flush()

    expect(entries()['video-model']).toMatchObject({ status: 'error', error: 'disk full' })

    const calls = getModelInstallStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(getModelInstallStatus.mock.calls.length).toBe(calls)
  })

  it('dismisses the entry when the slot reads idle (app restarted under us)', async () => {
    getMlxInstallStatus.mockResolvedValueOnce(slot({ status: 'idle' }))

    useMlxInstallStore.getState().watch('video-engine', 'MLX video engine')
    expect(entries()['video-engine']).toBeDefined()

    await flush()
    expect(entries()['video-engine']).toBeUndefined()

    const calls = getMlxInstallStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(getMlxInstallStatus.mock.calls.length).toBe(calls)
  })

  it('treats a failed poll as transient and keeps watching', async () => {
    getMlxImageEngineStatus
      .mockRejectedValueOnce(new Error('slot busy'))
      .mockResolvedValueOnce(slot({ status: 'complete' }))

    useMlxInstallStore.getState().watch('image-engine', 'MLX image engine')
    await flush()

    // The failed read left the seeded entry alone…
    expect(entries()['image-engine']).toMatchObject({ status: 'installing', progress: 0 })

    // …and the next interval tick still ran and saw the terminal state.
    await vi.advanceTimersByTimeAsync(1200)
    expect(entries()['image-engine']).toMatchObject({ status: 'complete' })
  })

  it('adopt() watches only slots that are mid-install', async () => {
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    getMlxImageInstallStatus
      .mockResolvedValueOnce(slot()) // adopt's probe
      .mockResolvedValueOnce(slot({ download_progress: 1, download_total: 2 })) // watch's immediate tick
      .mockResolvedValueOnce(slot({ status: 'complete' }))
    getMlxInstallStatus.mockRejectedValue(new Error('400 not this platform'))
    getModelInstallStatus.mockResolvedValue(slot({ status: 'complete' }))

    await useMlxInstallStore.getState().adopt()
    await flush()

    expect(Object.keys(entries())).toEqual(['image-model'])
    expect(entries()['image-model']).toMatchObject({ label: 'Image model', progress: 1, total: 2 })

    await vi.advanceTimersByTimeAsync(1200)
    expect(entries()['image-model']).toMatchObject({ status: 'complete' })
  })

  it('dismiss() removes an entry', async () => {
    getModelInstallStatus.mockResolvedValueOnce(slot({ status: 'complete' }))
    useMlxInstallStore.getState().watch('video-model', 'Wan 2.1')
    await flush()

    useMlxInstallStore.getState().dismiss('video-model')
    expect(entries()['video-model']).toBeUndefined()
  })
})

/**
 * A click is answered before Rust is (owner's Mac, 08.10.2026).
 *
 * Get took five seconds to show anything and Stop took longer, because both
 * waited for a backend that was busy. The store now shows the row of a Get at
 * once (begin) and takes the rows of a lane away at once (stop). These tests
 * pin both, and what happens when Rust says no afterwards: the row that was a
 * guess goes, the rows that were taken come back.
 */
describe('mlxInstallStore: the click is answered first', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    resetMlxInstallStoreForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const store = () => useMlxInstallStore.getState()
  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('begin shows the row at once and asks Rust nothing', async () => {
    store().begin('image-model', 'FLUX.2 klein 4B', 'flux2-klein-4b')
    expect(entries()['image-model']).toMatchObject({ status: 'installing', label: 'FLUX.2 klein 4B', modelId: 'flux2-klein-4b', pending: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(getMlxImageInstallStatus).not.toHaveBeenCalled()
  })

  it('watch confirms a row that begin showed, and from then on it is polled', async () => {
    getMlxImageInstallStatus.mockResolvedValue(slot({ download_progress: 1, download_total: 4 }))
    store().begin('image-model', 'SD Turbo', 'sd-turbo')
    store().watch('image-model', 'SD Turbo', 'sd-turbo')
    expect(entries()['image-model'].pending).toBeUndefined()
    await flush()
    expect(entries()['image-model']).toMatchObject({ progress: 1, total: 4, modelId: 'sd-turbo' })
  })

  it('begin leaves an install alone that is already followed', async () => {
    getMlxImageInstallStatus.mockResolvedValue(slot({ download_progress: 3, download_total: 4 }))
    store().watch('image-model', 'SD Turbo', 'sd-turbo')
    await flush()
    store().begin('image-model', 'Another model', 'another')
    expect(entries()['image-model']).toMatchObject({ label: 'SD Turbo', modelId: 'sd-turbo', progress: 3 })
  })

  it('abandon takes back a row Rust never confirmed, and no other', async () => {
    store().begin('video-model', 'Wan 2.1', 'wan21-t2v-1.3b')
    store().abandon('video-model')
    expect(entries()['video-model']).toBeUndefined()

    getModelInstallStatus.mockResolvedValue(slot())
    store().watch('video-model', 'Wan 2.1', 'wan21-t2v-1.3b')
    await flush()
    store().abandon('video-model')
    expect(entries()['video-model']).toMatchObject({ status: 'installing' })
  })

  it('Stop takes the rows of its lane away in the same call, before Rust has answered', async () => {
    const cancel = deferred<{ ok: boolean }>()
    cancelMlxImageInstall.mockReturnValue(cancel.promise)
    getMlxImageInstallStatus.mockResolvedValue(slot())
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    getModelInstallStatus.mockResolvedValue(slot())
    store().watch('image-model', 'FLUX.2 klein 4B', 'flux2-klein-4b')
    store().watch('video-model', 'Wan 2.1', 'wan21-t2v-1.3b')
    await flush()
    const before = mlxLaneGeneration('image')

    const stopped = store().stop('image')
    // Synchronously: no await between the click and this line.
    expect(entries()['image-model']).toBeUndefined()
    expect(entries()['video-model']).toMatchObject({ status: 'installing' })
    expect(mlxLaneGeneration('image')).toBe(before + 1)
    expect(mlxLaneGeneration('video')).toBe(0)

    await flush()
    expect(cancelMlxImageInstall).toHaveBeenCalledTimes(1)
    expect(cancelVideoModelInstall).not.toHaveBeenCalled()

    // Rust is slow to answer and the download slow to end. Nothing comes back.
    await vi.advanceTimersByTimeAsync(3000)
    expect(entries()['image-model']).toBeUndefined()
    cancel.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(entries()['image-model']).toBeUndefined()

    // The slot is free: the Stop is through, without an error anywhere.
    getMlxImageInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    await vi.advanceTimersByTimeAsync(300)
    await expect(stopped).resolves.toBeUndefined()
    expect(Object.values(entries()).some((e) => e.status === 'error')).toBe(false)
    store().dismiss('video-model')
  })

  it('a second click on Stop is the same Stop', async () => {
    cancelVideoModelInstall.mockResolvedValue({ ok: true })
    getModelInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    getMlxInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    store().begin('video-model', 'Wan 2.1', 'wan21-t2v-1.3b')
    const first = store().stop('video')
    const second = store().stop('video')
    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(300)
    await first
    expect(cancelVideoModelInstall).toHaveBeenCalledTimes(1)
    expect(mlxLaneGeneration('video')).toBe(1)
  })

  it('a read that was on its way when Stop was clicked does not bring the row back', async () => {
    const read = deferred<ReturnType<typeof slot>>()
    getMlxImageInstallStatus.mockReturnValueOnce(read.promise).mockResolvedValue(slot({ status: 'idle' }))
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    cancelMlxImageInstall.mockResolvedValue({ ok: true })
    store().watch('image-model', 'SD Turbo', 'sd-turbo')

    const stopped = store().stop('image')
    expect(entries()['image-model']).toBeUndefined()
    read.resolve(slot({ download_progress: 9, download_total: 10 }))
    await flush()
    expect(entries()['image-model']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    await stopped
  })

  it('Stop lets a start through that is still on its way, so it cannot overtake it', async () => {
    const start = deferred<{ ok: boolean }>()
    cancelMlxImageInstall.mockResolvedValue({ ok: true })
    getMlxImageInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    store().begin('image-model', 'SD Turbo', 'sd-turbo')
    void store().starting('image', start.promise)

    const stopped = store().stop('image')
    expect(entries()['image-model']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    expect(cancelMlxImageInstall).not.toHaveBeenCalled()
    start.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(cancelMlxImageInstall).toHaveBeenCalledTimes(1)
    await stopped
  })

  it('a Stop that Rust refuses puts the rows back and says so to its caller', async () => {
    cancelMlxImageInstall.mockRejectedValue(new Error('backend said no'))
    getMlxImageInstallStatus.mockResolvedValue(slot({ download_progress: 2, download_total: 8 }))
    store().watch('image-model', 'FLUX.2 klein 4B', 'flux2-klein-4b')
    await flush()

    const stopped = store().stop('image')
    expect(entries()['image-model']).toBeUndefined()
    await expect(stopped).rejects.toThrow('backend said no')
    await flush()
    // Back, as the row it was: the tile it belongs to can find it again.
    expect(entries()['image-model']).toMatchObject({ status: 'installing', label: 'FLUX.2 klein 4B', modelId: 'flux2-klein-4b', progress: 2 })
    // And a later Stop is a new Stop, not the failed one handed out again.
    cancelMlxImageInstall.mockResolvedValue({ ok: true })
    getMlxImageInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    const again = store().stop('image')
    await vi.advanceTimersByTimeAsync(300)
    await expect(again).resolves.toBeUndefined()
  })

  it('settled waits for a Stop to be through, and never throws', async () => {
    const cancel = deferred<{ ok: boolean }>()
    cancelVideoModelInstall.mockReturnValue(cancel.promise)
    getModelInstallStatus.mockResolvedValue(slot())
    getMlxInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    store().begin('video-model', 'Wan 2.1', 'wan21-t2v-1.3b')
    // Nothing is stopping: through at once.
    await store().settled('image')

    void store().stop('video').catch(() => {})
    let through = false
    void store().settled('video').then(() => { through = true })
    cancel.resolve({ ok: true })
    // The download has not ended yet, so the slot is not free yet.
    await vi.advanceTimersByTimeAsync(600)
    expect(through).toBe(false)
    getModelInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    await vi.advanceTimersByTimeAsync(300)
    expect(through).toBe(true)

    // A Stop that failed does not make the next start fail.
    cancelVideoModelInstall.mockRejectedValue(new Error('no'))
    void store().stop('video').catch(() => {})
    await expect(store().settled('video')).resolves.toBeUndefined()
  })

  it('adopt does not pick up the install a Stop is ending', async () => {
    const cancel = deferred<{ ok: boolean }>()
    cancelMlxImageInstall.mockReturnValue(cancel.promise)
    // Still "installing": the process has not ended yet.
    getMlxImageInstallStatus.mockResolvedValue(slot())
    getMlxImageEngineStatus.mockResolvedValue(slot({ status: 'idle' }))
    getMlxInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    getModelInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    store().watch('image-model', 'SD Turbo', 'sd-turbo')
    await flush()
    void store().stop('image')
    await store().adopt()
    await flush()
    expect(entries()['image-model']).toBeUndefined()
    cancel.resolve({ ok: true })
    getMlxImageInstallStatus.mockResolvedValue(slot({ status: 'idle' }))
    await vi.advanceTimersByTimeAsync(300)
  })

  it('every kind belongs to the lane whose Stop ends it', () => {
    expect(mlxInstallLane('image-engine')).toBe('image')
    expect(mlxInstallLane('image-model')).toBe('image')
    expect(mlxInstallLane('video-engine')).toBe('video')
    expect(mlxInstallLane('video-model')).toBe('video')
  })
})
