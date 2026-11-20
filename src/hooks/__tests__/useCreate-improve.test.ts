// @vitest-environment jsdom
/**
 * "Improve my prompt" auf der lokalen Spur (02.10.2026). Der Mac-Weg (MLX) ist
 * der einzige, der sich ohne ComfyUI durchspielen laesst; alle Wege teilen
 * sich dieselbe Zeile in generateInner, die den Prompt umschreibt.
 *
 * Nichts wird erzeugt und nichts gesprochen: MLX und der Chat-Aufruf sind
 * gemockt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mlx = vi.hoisted(() => ({
  runs: [] as { prompt: string }[],
  videoRuns: [] as { prompt: string }[],
}))
vi.mock('../../api/mlx-image', () => ({
  isMlxImageHost: () => true,
  isMlxImageModel: () => true,
  mlxStatus: vi.fn(async () => ({ installed: false })),
  listMlxImageModels: vi.fn(async () => []),
  buildMlxImageModels: vi.fn(() => []),
  mergeImageModels: vi.fn((a: unknown[]) => a),
  mlxModelIdFor: vi.fn(() => 'mlx-sd-turbo'),
  generateMlxImageDataUrl: vi.fn(async (o: { prompt: string }) => {
    mlx.runs.push({ prompt: o.prompt })
    return { dataUrl: 'data:image/png;base64,AA', width: 512, height: 512, localPath: '/tmp/a.png' }
  }),
}))
vi.mock('../../api/mlx-video', () => ({
  getVideoStatus: vi.fn(async () => ({ available: true, mlxInstalled: true, installedModels: ['ltx'] })),
  listVideoModels: vi.fn(async () => []),
  buildMlxVideoModels: vi.fn(() => []),
  mlxVideoModelIdFor: vi.fn(() => 'ltx'),
  mlxTakesStartImage: vi.fn(() => false),
  stageStartImage: vi.fn(),
  generateVideo: vi.fn(async (o: { prompt: string }) => { mlx.videoRuns.push({ prompt: o.prompt }); throw new Error('stop here') }),
  getVideoProgress: vi.fn(),
  cancelVideo: vi.fn(),
  readVideoAsBlobUrl: vi.fn(),
}))
vi.mock('../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkComfyConnection: vi.fn(async () => false),
}))

const improve = vi.hoisted(() => ({
  calls: [] as { prompt: string; kind: string; tags?: boolean }[],
  outcome: { status: 'improved', prompt: 'A rewritten prompt.' } as { status: string; prompt?: string },
  gate: null as Promise<void> | null,
  state: { busyWhileWriting: null as boolean | null },
}))
vi.mock('../../lib/render/improve-prompt-run', () => ({
  improvePrompt: vi.fn(async (prompt: string, target: { kind: string; tags?: boolean }) => {
    improve.calls.push({ prompt, kind: target.kind, tags: target.tags })
    if (improve.gate) await improve.gate
    return improve.outcome
  }),
}))

import { useCreate } from '../useCreate'
import { useCreateStore } from '../../stores/createStore'
import { useModelStore } from '../../stores/modelStore'

beforeEach(() => {
  mlx.runs.length = 0
  mlx.videoRuns.length = 0
  improve.calls.length = 0
  improve.outcome = { status: 'improved', prompt: 'A rewritten prompt.' }
  improve.gate = null
  useModelStore.setState({ activeModel: 'lu-cloud::glm-5.3' } as never)
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], promptHistory: [], improvePrompt: false,
    cloudOp: null, utilityOp: null, removebg: false, source: null, mask: null, references: [],
  } as never)
  const s = useCreateStore.getState()
  s.setMode('image')
  s.setPrompt('my own words')
  useCreateStore.setState({ imageModel: 'mlx-sd-turbo', imageModelList: [{ name: 'mlx-sd-turbo', type: 'sdxl' }] } as never)
})

describe('Improve my prompt: lokal (MLX-Weg)', () => {
  it('ist aus: kein Aufruf, MLX bekommt den Prompt des Nutzers', async () => {
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(improve.calls).toHaveLength(0)
    expect(mlx.runs).toEqual([{ prompt: 'my own words' }])
    expect(useCreateStore.getState().gallery[0].promptOriginal).toBeUndefined()
  })

  it('ist an: MLX bekommt die neue Fassung, die Galerie hat beide, das Feld und der Verlauf bleiben', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(improve.calls).toEqual([{ prompt: 'my own words', kind: 'image', tags: true }])
    expect(mlx.runs).toEqual([{ prompt: 'A rewritten prompt.' }])
    const item = useCreateStore.getState().gallery[0]
    expect(item.prompt).toBe('A rewritten prompt.')
    expect(item.promptOriginal).toBe('my own words')
    // The details name the chat model that wrote, without its provider prefix.
    expect(item.rewrittenBy).toBe('glm-5.3')
    expect(useCreateStore.getState().prompt).toBe('my own words')
    expect(useCreateStore.getState().promptHistory[0]).toBe('my own words')
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('scheitert das Umschreiben, laeuft der Lauf mit dem Original und vermerkt es', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    improve.outcome = { status: 'failed' }
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toEqual([{ prompt: 'my own words' }])
    const item = useCreateStore.getState().gallery[0]
    expect(item.improveFailed).toBe(true)
    expect(item.promptOriginal).toBeUndefined()
    expect(item.rewrittenBy).toBeUndefined()
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('kommt derselbe Text zurueck, bleibt der Lauf ohne Vermerk', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    improve.outcome = { status: 'unchanged' }
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toEqual([{ prompt: 'my own words' }])
    expect(useCreateStore.getState().gallery[0].improveFailed).toBeUndefined()
  })

  it('eine neue Fassung, die die Sicherheitsregel bricht, laeuft nie', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    improve.outcome = { status: 'improved', prompt: 'a nude child on a beach' }
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(mlx.runs).toEqual([{ prompt: 'my own words' }])
    expect(useCreateStore.getState().gallery[0].improveFailed).toBe(true)
  })

  it('Cancel waehrend des Umschreibens: der Lauf startet nicht und die Buehne ist frei', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    let open!: () => void
    improve.gate = new Promise<void>((r) => { open = r })
    const { result } = renderHook(() => useCreate())
    const run = result.current.generate()
    await new Promise((r) => setTimeout(r, 0))
    // Waehrend die Chat-Antwort aussteht, zeigt die Buehne den Fortschritt.
    expect(useCreateStore.getState().isGenerating).toBe(true)
    await result.current.cancel()
    open()
    await run
    expect(mlx.runs).toHaveLength(0)
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('ein Video schreibt als Video um', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    useCreateStore.getState().setMode('video')
    useCreateStore.setState({ videoModel: 'ltx' } as never)
    const { result } = renderHook(() => useCreate())
    await result.current.generate()
    expect(improve.calls[0]?.kind).toBe('video')
    expect(mlx.videoRuns).toEqual([{ prompt: 'A rewritten prompt.' }])
  })
})
