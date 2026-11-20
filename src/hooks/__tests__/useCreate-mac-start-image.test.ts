// @vitest-environment jsdom
/**
 * The Mac's local video run and its start image (08.10.2026).
 *
 * Animate Image hands `video_generate` the image on the Stage as a path on
 * disk. Video stays text to video and passes none. A model that cannot run
 * without an image is stopped in words before anything loads: the engine
 * would spend minutes loading sixty gigabytes and then fail on a tensor shape.
 *
 * Nothing is generated: the MLX module is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mlx = vi.hoisted(() => ({
  runs: [] as { id: string; prompt: string; initImage?: string; negativePrompt?: string }[],
  staged: [] as number[],
  ids: { 'MLX Wan 2.1 T2V 1.3B': 'wan21-t2v-1.3b', 'MLX Wan 2.2 TI2V 5B 8-bit': 'wan22-ti2v-5b-q8', 'MLX Wan 2.2 I2V A14B': 'wan22-i2v-a14b' } as Record<string, string>,
}))
vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: () => true,
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn(() => 'mlx-sd-turbo'),
  generateMlxImageDataUrl: vi.fn(),
}))
vi.mock('../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: true, mlxInstalled: true, installedModels: Object.values(mlx.ids) })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
  mlxVideoModelIdFor: vi.fn((name: string) => mlx.ids[name] ?? null),
  stageStartImage: vi.fn(async (b: Blob) => { mlx.staged.push(b.size); return '/data/videos/start-images/late.png' }),
  generateVideo: vi.fn(async (o: { id: string; prompt: string; initImage?: string; negativePrompt?: string }) => {
    mlx.runs.push({ id: o.id, prompt: o.prompt, initImage: o.initImage, negativePrompt: o.negativePrompt })
    throw new Error('stop here')
  }),
  getVideoProgress: vi.fn(),
  cancelVideo: vi.fn(),
  readVideoAsBlobUrl: vi.fn(),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => false),
}))
// The hand-over of memory asks the chat backends what is loaded. That is not
// what these tests are about, and its requests must not count as theirs.
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import type { ClassifiedModel } from '../../api/comfyui'

const model = (name: string, startImage: ClassifiedModel['startImage']): ClassifiedModel =>
  ({ name, type: 'wan', source: 'checkpoint', startImage })
const WAN21 = model('MLX Wan 2.1 T2V 1.3B', 'none')
const TI2V = model('MLX Wan 2.2 TI2V 5B 8-bit', 'optional')
const I2V = model('MLX Wan 2.2 I2V A14B', 'required')
const STAGED = { filename: '/data/videos/start-images/abc.png', url: 'data:image/png;base64,AA', width: 640, height: 480 }

function arrange(intent: 'video' | 'animate', list: ClassifiedModel[], pick: string, source: typeof STAGED | null) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], improvePrompt: false,
    cloudOp: null, utilityOp: null, removebg: false, mask: null, references: [],
    videoModelList: list, videoModel: pick,
  } as never)
  const s = useCreateStore.getState()
  s.setIntent(intent)
  s.setPrompt('slow push in')
  // After setIntent: a tab change may clear the Stage.
  useCreateStore.setState({ source } as never)
}

beforeEach(() => {
  mlx.runs.length = 0
  mlx.staged.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['12345'], { type: 'image/png' }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the Mac hands the engine the image on the Stage', () => {
  it('Animate passes the staged path to video_generate', async () => {
    arrange('animate', [WAN21, TI2V], TI2V.name, STAGED)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toEqual([{ id: 'wan22-ti2v-5b-q8', prompt: 'slow push in', initImage: STAGED.filename }])
    expect(mlx.staged).toHaveLength(0)
  })

  it('Animate runs the model on the chip: a text only pick gives way to the first that takes an image', async () => {
    arrange('animate', [WAN21, I2V], WAN21.name, STAGED)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs.map((r) => r.id)).toEqual(['wan22-i2v-a14b'])
    expect(mlx.runs[0].initImage).toBe(STAGED.filename)
  })

  it('an image picked in cloud mode is written to disk before the run', async () => {
    // Five bytes as the data: URL a picked image is held as. They are decoded
    // and not fetched: the webview's content policy refuses a fetch of data:.
    arrange('animate', [TI2V], TI2V.name, { ...STAGED, url: `data:image/png;base64,${btoa('12345')}`, filename: '' })
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.staged).toEqual([5])
    expect(fetch).not.toHaveBeenCalled()
    expect(mlx.runs[0].initImage).toBe('/data/videos/start-images/late.png')
  })

  it('Video passes no image, also with one left on the Stage and a model that could take it', async () => {
    arrange('video', [WAN21, TI2V], TI2V.name, STAGED)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toEqual([{ id: 'wan22-ti2v-5b-q8', prompt: 'slow push in', initImage: undefined }])
  })
})

describe('a missing start image is said before anything loads', () => {
  it('Animate without an image starts nothing', async () => {
    arrange('animate', [TI2V, I2V], I2V.name, null)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toHaveLength(0)
    expect(useCreateStore.getState().error).toBe('Add a start image first.')
  })

  it('Video with only a model that needs one points to Animate Image', async () => {
    arrange('video', [I2V], I2V.name, null)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toHaveLength(0)
    expect(useCreateStore.getState().error).toBe('"MLX Wan 2.2 I2V A14B" needs a start image. Open Animate Image to give it one.')
  })

  it('Video never picks the model that needs one while another runs from text', async () => {
    arrange('video', [I2V, WAN21], I2V.name, null)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs.map((r) => r.id)).toEqual(['wan21-t2v-1.3b'])
  })
})

// Since 82ff5890 `video_generate` takes a negative prompt and the catalogue
// says per model whether one is read (`negativePrompt`). Wan reads it. A
// distilled LTX does not, and the second engine ends with an error on the
// flag, so what an image tab left in the field must not travel along.
describe('the negative prompt goes to the models that read one', () => {
  const clip = (negativePrompt: boolean) => ({ frames: 81, fps: 16, frameStep: 4, width: 832, height: 480, negativePrompt })
  const reads: ClassifiedModel = { ...WAN21, mlxVideo: clip(true) }
  const readsNone: ClassifiedModel = { ...TI2V, mlxVideo: clip(false) }

  it('a model that reads one gets it, trimmed', async () => {
    arrange('video', [reads, readsNone], reads.name, null)
    useCreateStore.getState().setNegativePrompt('  blurry, static  ')
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs[0]).toMatchObject({ id: 'wan21-t2v-1.3b', negativePrompt: 'blurry, static' })
  })

  it('COUNTER-CHECK: a model that reads none gets none, whatever is in the field', async () => {
    arrange('video', [reads, readsNone], readsNone.name, null)
    useCreateStore.getState().setNegativePrompt('blurry, static')
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs[0].id).toBe('wan22-ti2v-5b-q8')
    expect(mlx.runs[0].negativePrompt).toBeUndefined()
  })

  it('an empty field sends nothing', async () => {
    arrange('video', [reads], reads.name, null)
    useCreateStore.getState().setNegativePrompt('   ')
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs[0].negativePrompt).toBeUndefined()
  })
})
