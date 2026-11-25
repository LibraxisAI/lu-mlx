// @vitest-environment jsdom
/**
 * Erase Object on the Mac via LaMa (`commands/mlx_erase.rs`):
 * fast, deterministic inpainting without hallucinating objects over masked regions.
 * Both the restored macOS `eraser` tab and promptless masked `edit` (`removeRun`)
 * hand the staged source + mask + feather to `mlx_erase`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mlx = vi.hoisted(() => ({
  erases: [] as Array<{ image: string; mask: string; featherPx?: number }>,
  staged: [] as number[],
  fail: null as string | null,
}))
vi.mock('../../api/mlx-image', () => ({
  MAC_CUTOUT_TOOL: 'macOS Vision',
  MAC_ERASE_TOOL: 'LaMa',
  isMlxImageHost: () => true,
  isMlxImageModel: (name: string) => name.startsWith('MLX '),
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn(() => 'sd-turbo'),
  generateMlxImageDataUrl: vi.fn(async () => { throw new Error('diffusion engine must not run for LaMa erase') }),
  cutOutOnMac: vi.fn(async () => { throw new Error('cutout must not run for erase') }),
  eraseOnMac: vi.fn(async (image: string, mask: string, featherPx?: number) => {
    mlx.erases.push({ image, mask, featherPx })
    if (mlx.fail) throw new Error(mlx.fail)
    return { dataUrl: 'data:image/png;base64,ERASED', width: 1024, height: 1024, localPath: '/data/images/erase-1-2.png' }
  }),
}))
vi.mock('../../api/mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: false, installedModels: [] })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
  stageStartImage: vi.fn(async (b: Blob) => {
    mlx.staged.push(b.size)
    return `/data/videos/start-images/staged-${mlx.staged.length}.png`
  }),
}))
const comfy = vi.hoisted(() => ({ asked: 0 }))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => { comfy.asked += 1; return false }),
  submitWorkflow: vi.fn(async () => { comfy.asked += 1; return 'p1' }),
}))
vi.mock('../../api/vram-handoff', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  evictChatBackendsForRender: vi.fn(async () => null),
  restoreChatBackendsAfterRender: vi.fn(),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { resultFacts } from '../../lib/render/result-facts'

const SOURCE = { filename: '/data/videos/start-images/src.png', url: 'data:image/png;base64,AA', width: 1024, height: 1024 }
const MASK = { filename: '/data/videos/start-images/mask.png', url: 'data:image/png;base64,MM', width: 1024, height: 1024 }

function arrange(intent: 'eraser' | 'edit' = 'eraser') {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], improvePrompt: false,
    cloudOp: null, utilityOp: null, removebg: false, mask: null, references: [], batchSources: [], source: null,
    mode: 'image', imageSubMode: 'text2img', transparentBackground: false, batchSize: 1, seed: 7, negativePrompt: '',
    growMaskBy: 8,
    imageModelList: [{ name: 'MLX Qwen Image 2.1', type: 'qwenimage', source: 'checkpoint', editImages: 1 }],
    videoModelList: [],
    caps: { rmbg: false, 'inpaint-nodes': false, dwpose: false },
  } as never)
  useCreateStore.getState().setIntent(intent)
  useCreateStore.getState().setPrompt('')
}
const state = () => useCreateStore.getState()

beforeEach(() => {
  mlx.erases.length = 0
  mlx.staged.length = 0
  mlx.fail = null
  comfy.asked = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['12345'], { type: 'image/png' }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Erase Object on the Mac (LaMa)', () => {
  it('sends staged image + mask to LaMa and records LaMa in gallery facts without calling ComfyUI', async () => {
    arrange('eraser')
    useCreateStore.setState({ source: SOURCE, mask: MASK } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.erases).toEqual([{
      image: '/data/videos/start-images/src.png',
      mask: '/data/videos/start-images/mask.png',
      featherPx: 8,
    }])
    expect(mlx.staged).toEqual([])
    expect(state().error).toBeNull()
    expect(state().isGenerating).toBe(false)
    const [made] = state().gallery
    expect(made).toMatchObject({
      type: 'image', intent: 'eraser', prompt: '', toolModel: 'LaMa',
      width: 1024, height: 1024, dataUrl: 'data:image/png;base64,ERASED', localPath: '/data/images/erase-1-2.png',
    })
    expect(resultFacts(made)).toEqual(['1024×1024', 'LaMa'])
    expect(comfy.asked).toBe(0)
  })

  it('stages non-absolute cloud/comfy image and mask paths onto disk first', async () => {
    arrange('eraser')
    useCreateStore.setState({
      source: { ...SOURCE, filename: '' },
      mask: { ...MASK, filename: 'bare-comfy-mask.png' },
    } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.staged).toHaveLength(2)
    expect(mlx.erases).toEqual([{
      image: '/data/videos/start-images/staged-1.png',
      mask: '/data/videos/start-images/staged-2.png',
      featherPx: 8,
    }])
    expect(state().gallery).toHaveLength(1)
  })

  it('requires a painted mask and surfaces error without calling LaMa when missing', async () => {
    arrange('eraser')
    useCreateStore.setState({ source: SOURCE, mask: null } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(state().error).toBe('Paint over the object or area you want to erase.')
    expect(mlx.erases).toEqual([])
    expect(state().gallery).toEqual([])
  })

  it('also routes promptless masked Edit on Mac through fast LaMa erase', async () => {
    arrange('edit')
    useCreateStore.setState({ source: SOURCE, mask: MASK } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.erases).toEqual([{
      image: '/data/videos/start-images/src.png',
      mask: '/data/videos/start-images/mask.png',
      featherPx: 8,
    }])
    expect(state().gallery[0]).toMatchObject({ intent: 'edit', toolModel: 'LaMa' })
  })

  it('surfaces backend LaMa errors cleanly without adding broken entries', async () => {
    arrange('eraser')
    useCreateStore.setState({ source: SOURCE, mask: MASK } as never)
    mlx.fail = 'Local Erase timed out'
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(state().error).toBe('Erase failed: Local Erase timed out')
    expect(state().gallery).toEqual([])
    expect(state().isGenerating).toBe(false)
    expect(comfy.asked).toBe(0)
  })
})
