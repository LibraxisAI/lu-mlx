// @vitest-environment jsdom
/**
 * Fehlerkontrolle Mac 3, 08.10.2026, in Create on the Mac:
 *
 *   Fund 8   After Cancel the engine may still be at the image for a moment
 *            (a model that is loading cannot be interrupted). A click on
 *            Create in that time was swallowed without a word. It is now
 *            answered with one line, and the image of the cancelled run
 *            never reaches the gallery.
 *   Fund 9   The gallery writes the guidance the run took. For a pack that
 *            reads no slider that is the engine's number and not the slider's.
 *   Fund 10  A batch counts its seeds the way the cloud lane does, around
 *            the end of the range.
 *
 * Nothing is generated: the MLX module is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mlx = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  /** Ends the run that is waiting, whatever its signal says. */
  finish: null as null | (() => void),
  wait: false,
  made: { dataUrl: 'data:image/png;base64,AAAA', width: 1024, height: 1024, localPath: '/i/mlx-1.png', steps: 9, guidance: 0 } as Record<string, unknown>,
}))
vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: (name: string) => name.startsWith('MLX '),
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn(() => 'z-image-turbo-4bit'),
  generateMlxImageDataUrl: vi.fn(async (args: Record<string, unknown>) => {
    mlx.runs.push(args)
    // An engine that cannot be interrupted: it comes back when it is done.
    if (mlx.wait) await new Promise<void>((resolve) => { mlx.finish = resolve })
    return mlx.made
  }),
}))
vi.mock('../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: false, installedModels: [] })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => false),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import type { ClassifiedModel } from '../../api/comfyui'

const ZIMAGE: ClassifiedModel = { name: 'MLX Z-Image Turbo 4-bit', type: 'zimage', source: 'checkpoint', editImages: 0, ownSampling: true }
const STILL = 'The previous image is still finishing. Try again in a moment.'
const state = () => useCreateStore.getState()
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

beforeEach(() => {
  mlx.runs.length = 0
  mlx.finish = null
  mlx.wait = false
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], improvePrompt: false,
    cloudOp: null, utilityOp: null, removebg: false, mask: null, references: [], batchSources: [], source: null,
    mode: 'image', imageSubMode: 'text2img', transparentBackground: false, batchSize: 1, seed: 7, negativePrompt: '',
    imageModelList: [ZIMAGE], videoModelList: [],
  } as never)
  const s = useCreateStore.getState()
  s.setImageModel(ZIMAGE.name, ZIMAGE.type)
  s.setIntent('image')
  s.setPrompt('a red apple')
})

describe('Create again while the cancelled image is still finishing', () => {
  it('is answered with a line, and the cancelled image never reaches the gallery', async () => {
    mlx.wait = true
    const { result } = renderHook(() => useCreate())
    let first: Promise<void> = Promise.resolve()
    act(() => { first = result.current.generate() })
    await settle()
    expect(mlx.runs).toHaveLength(1)
    expect(state().isGenerating).toBe(true)

    // Cancel frees the surface at once and says nothing.
    await act(async () => { await result.current.cancel() })
    expect(state().isGenerating).toBe(false)
    expect(state().error).toBeNull()

    // The engine is still at it. A click now is told so.
    await act(async () => { await result.current.generate() })
    expect(state().error).toBe(STILL)
    expect(mlx.runs).toHaveLength(1)

    // It comes back with its image: dropped, and the line goes with it.
    await act(async () => { mlx.finish!(); await first })
    expect(state().gallery).toHaveLength(0)
    expect(state().error).toBeNull()
    expect(state().isGenerating).toBe(false)

    // And now the click starts a run.
    mlx.wait = false
    await act(async () => { await result.current.generate() })
    expect(mlx.runs).toHaveLength(2)
    expect(state().gallery).toHaveLength(1)
  })

  it('a second click while a run is simply under way stays silent', async () => {
    mlx.wait = true
    const { result } = renderHook(() => useCreate())
    let first: Promise<void> = Promise.resolve()
    act(() => { first = result.current.generate() })
    await settle()
    await act(async () => { await result.current.generate() })
    expect(state().error).toBeNull()
    expect(mlx.runs).toHaveLength(1)
    await act(async () => { mlx.finish!(); await first })
    expect(state().gallery).toHaveLength(1)
  })
})

describe('what the gallery says a run took', () => {
  it('is the guidance the engine reports, not the slider of a pack that does not read it', async () => {
    useCreateStore.setState({ cfgScale: 4, steps: 25 } as never)
    const { result } = renderHook(() => useCreate())
    await act(async () => { await result.current.generate() })
    expect(state().gallery[0]).toMatchObject({ cfgScale: 0, steps: 9 })
  })
})

describe('the seeds of a batch', () => {
  it('wrap at the end of the range, as in the cloud lane', async () => {
    useCreateStore.setState({ seed: 2147483646, batchSize: 3 } as never)
    const { result } = renderHook(() => useCreate())
    await act(async () => { await result.current.generate() })
    const seeds = mlx.runs.map((r) => r.seed)
    expect(seeds).toEqual([2147483646, 0, 1])
    expect(state().gallery.map((g) => g.seed).sort()).toEqual([0, 1, 2147483646])
  })
})
