// @vitest-environment jsdom
/**
 * A click on Get, Stop or Remove is answered before the backend is.
 *
 * Owner's finding on the real Mac build (M5 Pro, 08.10.2026): a Get "loads
 * just as long before it starts" as the Model Manager took to open, and a
 * Stop took longer still. The backend was five seconds behind (video_status
 * imported MLX on the main thread), and the interface showed nothing until it
 * had answered: installMlxModel asked for the engine status before it did
 * anything one could see, and a stopped tile waited for the next poll of a
 * slot that was queued behind that status.
 *
 * The backend is fast again, and this file pins the other half: however slow
 * it is, the row of an install is there with the click and gone with the
 * Stop, and neither stays wrong when the backend says no.
 *
 * Run: npx vitest run src/api/__tests__/mlx-install-answers-the-click-first.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

type Reply = unknown | ((args: unknown) => unknown)
let replies: Record<string, Reply> = {}
const calls: string[] = []

vi.mock('../backend', () => ({
  backendCall: async (cmd: string, payload?: { args?: unknown }) => {
    calls.push(cmd)
    if (!(cmd in replies)) throw new Error(`unexpected command: ${cmd}`)
    const reply = replies[cmd]
    return typeof reply === 'function' ? (reply as (a: unknown) => unknown)(payload?.args) : reply
  },
  isTauri: () => true,
  isMacOS: () => true,
}))

import { installMlxModel, installMlxEngine, MlxInstallCancelled } from '../mlx-install'
import { useMlxInstallStore, resetMlxInstallStoreForTest } from '../../stores/mlxInstallStore'
import { useMlxMedia, forgetMlxMediaForTest, type MlxCatalogModel } from '../../hooks/useMlxMedia'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const idle = { status: 'idle', logs: [], error: null, download_progress: 0, download_total: 0, download_speed: 0 }
const installing = { ...idle, status: 'installing' }
const complete = { ...idle, status: 'complete' }
const entries = () => useMlxInstallStore.getState().entries
const FLUX = { id: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', family: 'diffusers' }
const sent = (cmd: string) => calls.filter((c) => c === cmd).length

beforeEach(() => {
  vi.useFakeTimers()
  replies = {
    mlx_status: { installed: true, running: false, port: 47712 },
    mlx_image_install_status: idle,
    install_mlx_diffusion_status: idle,
    video_install_mlx_status: idle,
    video_install_model_status: idle,
  }
  calls.length = 0
  resetMlxInstallStoreForTest()
  forgetMlxMediaForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Get', () => {
  it('shows the row of the model with the click, while the backend has not said a word', async () => {
    const status = deferred<unknown>()
    replies.mlx_status = () => status.promise
    const run = installMlxModel('image', FLUX, undefined, { engineReady: true })
    run.catch(() => {})
    // No await since the click.
    expect(entries()['image-model']).toMatchObject({ status: 'installing', modelId: 'flux2-klein-4b', label: 'FLUX.2 klein 4B', pending: true })
    // Five seconds of a busy backend later it is still there, and still a guess.
    await vi.advanceTimersByTimeAsync(5000)
    expect(entries()['image-model']).toMatchObject({ pending: true })
    expect(calls).toEqual(['mlx_status'])

    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = complete
    status.resolve({ installed: true, running: false, port: 47712 })
    await vi.advanceTimersByTimeAsync(1600)
    await expect(run).resolves.toBeUndefined()
    expect(entries()['image-model']).toMatchObject({ status: 'complete' })
    expect(entries()['image-model'].pending).toBeUndefined()
  })

  it('shows the engine first where the engine is known to be missing', async () => {
    const status = deferred<unknown>()
    replies.mlx_status = () => status.promise
    const run = installMlxModel('image', FLUX, undefined, { engineReady: false })
    run.catch(() => {})
    expect(entries()['image-engine']).toMatchObject({ status: 'installing', label: 'MLX image engine', pending: true })
    expect(entries()['image-model']).toBeUndefined()

    replies.install_mlx_diffusion = { ok: true, status: 'installing' }
    replies.install_mlx_diffusion_status = complete
    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = complete
    status.resolve({ installed: false, running: false, port: 47712 })
    await vi.advanceTimersByTimeAsync(3200)
    await expect(run).resolves.toBeUndefined()
    expect(calls.indexOf('install_mlx_diffusion')).toBeLessThan(calls.indexOf('mlx_image_install_model'))
  })

  it('a pack that brings its engine shows the model, whatever the first engine is', async () => {
    replies.mlx_status = { installed: false, running: false, port: 47712 }
    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = complete
    const run = installMlxModel('image', { id: 'qwen-image-2.1-8bit', name: 'Qwen-Image 2.1 8-bit', family: 'mflux' }, undefined, { engineReady: false })
    expect(entries()['image-model']).toMatchObject({ modelId: 'qwen-image-2.1-8bit', pending: true })
    expect(entries()['image-engine']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1600)
    await run
    expect(calls).not.toContain('install_mlx_diffusion')
  })

  it('a guess the backend corrects is taken back: the engine it turns out to need is shown', async () => {
    // The page thought the engine was there. It is not.
    replies.mlx_status = { installed: false, running: false, port: 47712 }
    replies.install_mlx_diffusion = { ok: true, status: 'installing' }
    replies.install_mlx_diffusion_status = installing
    const run = installMlxModel('image', FLUX, undefined, { engineReady: true })
    run.catch(() => {})
    expect(entries()['image-model']).toMatchObject({ pending: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(entries()['image-model']).toBeUndefined()
    expect(entries()['image-engine']).toMatchObject({ status: 'installing' })
    expect(calls).not.toContain('mlx_image_install_model')
    replies.install_mlx_diffusion_status = { ...idle, status: 'error', error: 'stop here' }
    await vi.advanceTimersByTimeAsync(1600)
    await expect(run).rejects.toThrow('stop here')
  })

  it('a start the backend refuses leaves no row behind, and its reason reaches the caller', async () => {
    replies.mlx_image_install_model = () => { throw new Error('Not enough free disk space for FLUX.2 klein 4B.') }
    const run = installMlxModel('image', FLUX, undefined, { engineReady: true })
    expect(entries()['image-model']).toMatchObject({ pending: true })
    await expect(run).rejects.toThrow('Not enough free disk space')
    expect(entries()['image-model']).toBeUndefined()
    expect(entries()['image-engine']).toBeUndefined()
  })

  it('the setup card: a refused engine setup takes its row back too', async () => {
    replies.install_mlx_diffusion = () => { throw new Error('A model download is running.') }
    const run = installMlxEngine('image')
    expect(entries()['image-engine']).toMatchObject({ pending: true })
    await expect(run).rejects.toThrow('A model download is running.')
    expect(entries()['image-engine']).toBeUndefined()
  })
})

describe('Stop', () => {
  it('ends the run that follows the install, and that is not an error', async () => {
    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = installing
    replies.mlx_image_cancel_install = { ok: true, cancelled: true }
    const run = installMlxModel('image', FLUX, undefined, { engineReady: true })
    const ended = run.then(() => 'finished', (e) => e)
    await vi.advanceTimersByTimeAsync(100)
    expect(entries()['image-model']).toMatchObject({ status: 'installing' })
    expect(entries()['image-model'].pending).toBeUndefined()

    const stopped = useMlxInstallStore.getState().stop('image')
    expect(entries()['image-model']).toBeUndefined()
    // The slot still says "installing": the download takes a moment to end.
    await vi.advanceTimersByTimeAsync(1600)
    expect(await ended).toBeInstanceOf(MlxInstallCancelled)
    expect(entries()['image-model']).toBeUndefined()
    replies.mlx_image_install_status = idle
    await vi.advanceTimersByTimeAsync(300)
    await expect(stopped).resolves.toBeUndefined()
    expect(sent('mlx_image_cancel_install')).toBe(1)
  })

  it('clicked while the start is still on its way: the start is let through, then stopped, and never followed', async () => {
    const start = deferred<unknown>()
    replies.mlx_image_install_model = () => start.promise
    replies.mlx_image_cancel_install = { ok: true, cancelled: true }
    const run = installMlxModel('image', FLUX, undefined, { engineReady: true })
    const ended = run.then(() => 'finished', (e) => e)
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toContain('mlx_image_install_model')

    const stopped = useMlxInstallStore.getState().stop('image')
    expect(entries()['image-model']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    // Not yet: a Stop that arrived before the start would stop nothing.
    expect(sent('mlx_image_cancel_install')).toBe(0)

    start.resolve({ ok: true, status: 'installing' })
    await vi.advanceTimersByTimeAsync(300)
    expect(sent('mlx_image_cancel_install')).toBe(1)
    expect(await ended).toBeInstanceOf(MlxInstallCancelled)
    // The run did not go on to follow the install it was told to drop.
    expect(entries()['image-model']).toBeUndefined()
    await stopped
  })

  it('the next Get waits until the stopped download has let go of the slot', async () => {
    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = installing
    replies.mlx_image_cancel_install = { ok: true, cancelled: true }
    const first = installMlxModel('image', FLUX, undefined, { engineReady: true })
    first.catch(() => {})
    await vi.advanceTimersByTimeAsync(100)
    void useMlxInstallStore.getState().stop('image')

    const second = installMlxModel('image', { id: 'sd-turbo', name: 'SD Turbo', family: 'diffusers' }, undefined, { engineReady: true })
    second.catch(() => {})
    // Its row is there at once all the same.
    expect(entries()['image-model']).toMatchObject({ modelId: 'sd-turbo', pending: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent('mlx_image_install_model')).toBe(1)

    // The run that was stopped has ended by now. It took its own rows with
    // it, and this one's row is not among them.
    expect(entries()['image-model']).toMatchObject({ modelId: 'sd-turbo', pending: true })

    // The first download is gone. Now the second start goes out, and its
    // slot reads "installing" from there on.
    replies.mlx_image_install_model = () => {
      replies.mlx_image_install_status = installing
      return { ok: true, status: 'installing' }
    }
    replies.mlx_image_install_status = idle
    await vi.advanceTimersByTimeAsync(200)
    expect(sent('mlx_image_install_model')).toBe(2)
    expect(entries()['image-model']).toMatchObject({ modelId: 'sd-turbo', status: 'installing' })
    replies.mlx_image_install_status = complete
    await vi.advanceTimersByTimeAsync(1600)
    await expect(second).resolves.toBeUndefined()
    expect(entries()['image-model']).toMatchObject({ modelId: 'sd-turbo', status: 'complete' })
  })
})

describe('the Model Manager hook', () => {
  const model = (over: Partial<MlxCatalogModel>): MlxCatalogModel => ({
    id: 'sd-turbo', name: 'SD Turbo', repo: 'stabilityai/sd-turbo', sizeBytes: 2_600_000_000, minRamGB: 8,
    unfiltered: false, description: '', installed: true, family: 'diffusers', ...over,
  })
  const catalogue = (installed: boolean) => [{ ...model({ installed }), sizeGB: 2.6, steps: 1, guidance: 0, defaultSize: 512 }]

  async function mounted() {
    replies.mlx_image_models = catalogue(true)
    replies.video_status = { available: true, appleSilicon: true, mlxInstalled: true, installedModels: [], running: false }
    replies.video_list_models = []
    const hook = renderHook(() => useMlxMedia(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(hook.result.current.loaded).toBe(true)
    return hook
  }

  it('Remove: the tile reads not installed with the click, while the backend is still deleting', async () => {
    const { result } = await mounted()
    const deleting = deferred<unknown>()
    replies.mlx_image_delete_model = () => deleting.promise
    let removal!: Promise<void>
    act(() => { removal = result.current.remove('image', 'sd-turbo') })
    expect(result.current.image.models[0].installed).toBe(false)

    replies.mlx_image_models = catalogue(false)
    deleting.resolve({ ok: true, id: 'sd-turbo' })
    await act(async () => { await removal })
    expect(result.current.image.models[0].installed).toBe(false)
    expect(result.current.image.error).toBeNull()
  })

  it('Remove the backend refuses: the tile is installed again, and the lane says why', async () => {
    const { result } = await mounted()
    replies.mlx_image_delete_model = () => { throw new Error('An install is running. Wait for it to finish first.') }
    let removal!: Promise<void>
    act(() => { removal = result.current.remove('image', 'sd-turbo') })
    expect(result.current.image.models[0].installed).toBe(false)
    await act(async () => { await removal })
    expect(result.current.image.models[0].installed).toBe(true)
    expect(result.current.image.error).toBe('An install is running. Wait for it to finish first.')
  })

  it('Get: the lane has its install in the same turn as the click', async () => {
    const { result } = await mounted()
    const status = deferred<unknown>()
    replies.mlx_status = () => status.promise
    act(() => { result.current.get('image', model({ id: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', installed: false })) })
    expect(result.current.image.modelInstall).toMatchObject({ modelId: 'flux2-klein-4b', status: 'installing' })
    expect(result.current.image.queuedId).toBe('flux2-klein-4b')
    // A refusal puts the tile back and leaves the reason on the lane.
    status.resolve({ installed: true, running: false, port: 47712 })
    replies.mlx_image_install_model = () => { throw new Error('Not enough free disk space.') }
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(result.current.image.modelInstall).toBeNull()
    expect(result.current.image.queuedId).toBeNull()
    expect(result.current.image.error).toBe('Not enough free disk space.')
  })

  it('Stop: the lane is free in the same turn, and a stopped install leaves no error', async () => {
    const { result } = await mounted()
    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = installing
    act(() => { result.current.get('image', model({ id: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', installed: false })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(result.current.image.modelInstall).toMatchObject({ modelId: 'flux2-klein-4b' })

    // The backend takes its time over the Stop.
    const cancel = deferred<unknown>()
    replies.mlx_image_cancel_install = () => cancel.promise
    act(() => { result.current.cancel('image') })
    expect(result.current.image.modelInstall).toBeNull()
    expect(result.current.image.queuedId).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(result.current.image.modelInstall).toBeNull()
    cancel.resolve({ ok: true, cancelled: true })
    replies.mlx_image_install_status = idle
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.image.error).toBeNull()
    expect(result.current.image.modelInstall).toBeNull()
  })

  it('a Stop the backend refuses: the tile is installing again, and the lane says why', async () => {
    const { result } = await mounted()
    replies.mlx_image_install_model = { ok: true, status: 'installing' }
    replies.mlx_image_install_status = installing
    act(() => { result.current.get('image', model({ id: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', installed: false })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    replies.mlx_image_cancel_install = () => { throw new Error('The backend did not answer.') }
    act(() => { result.current.cancel('image') })
    expect(result.current.image.modelInstall).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(result.current.image.modelInstall).toMatchObject({ modelId: 'flux2-klein-4b', status: 'installing' })
    expect(result.current.image.error).toBe('The backend did not answer.')
  })

  it('a Stop from the download tray frees a tile that waits for its engine, in the same turn', async () => {
    replies.mlx_status = { installed: false, running: false, port: 47712 }
    replies.install_mlx_diffusion = { ok: true, status: 'installing' }
    replies.install_mlx_diffusion_status = installing
    replies.mlx_image_cancel_install = { ok: true, cancelled: true }
    const { result } = await mounted()
    act(() => { result.current.get('image', model({ id: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', installed: false })) })
    // Engine first: its row is there with the click, and the tile waits.
    expect(result.current.image.engineInstall).toMatchObject({ status: 'installing' })
    expect(result.current.image.modelInstall).toBeNull()
    expect(result.current.image.queuedId).toBe('flux2-klein-4b')
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(calls).toContain('install_mlx_diffusion')

    // The tray calls the store, not this hook.
    act(() => { void useMlxInstallStore.getState().stop('image') })
    expect(result.current.image.engineInstall).toBeNull()
    expect(result.current.image.queuedId).toBeNull()

    replies.install_mlx_diffusion_status = idle
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.image.queuedId).toBeNull()
    expect(result.current.image.error).toBeNull()
    // The model was never asked for: the run ended with the Stop.
    expect(calls).not.toContain('mlx_image_install_model')
  })

  it('opened a second time, the page draws what it last read at once', async () => {
    const first = await mounted()
    first.unmount()
    // The backend is slow this time. The page is not.
    const slow = deferred<unknown>()
    replies.mlx_image_models = () => slow.promise
    const second = renderHook(() => useMlxMedia(true))
    expect(second.result.current.loaded).toBe(true)
    expect(second.result.current.image.models.map((m) => m.id)).toEqual(['sd-turbo'])
    slow.resolve(catalogue(false))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(second.result.current.image.models[0].installed).toBe(false)
  })
})
