/**
 * Customer report 02.10.2026 (Qwen Image Edit, "no mask needed"): the Desktop
 * asked for a painted mask before every cloud edit. An instruction editor
 * starts without one, and an old server that leaves `maskless` out of its
 * catalog changes nothing, because the bundled registration knows the flag.
 *
 * Nothing is generated: submit and upload are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

type Payload = { kind: string; model: string; prompt: string; params: Record<string, unknown> }
const hoisted = vi.hoisted(() => ({ submitted: [] as Payload[], hochgeladen: [] as string[] }))
const { submitted, hochgeladen } = hoisted

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))
vi.mock('../../api/cloud/jobs', () => {
  class CloudJobError extends Error { status = 0 }
  return {
    uploadInput: vi.fn(async (_b: unknown, slot: string) => { hochgeladen.push(slot); return `user-1/staged-${slot}.png` }),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    submitCloudJob: vi.fn(async (payload: Payload) => { submitted.push(payload); return { id: 'job-0', quota: { cost: 300 } } }),
    pollJob: vi.fn(async (id: string) => ({
      id, kind: 'image', model: 'qwen-image-edit', status: 'succeeded', result_url: `https://storage.example/${id}.png`,
      error: null, created_at: new Date().toISOString(), params: {},
    })),
    CloudJobError,
    QuoteChangedError: class extends CloudJobError {},
  }
})
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: vi.fn(async () => ({ credits: 5000 })),
  StudioQuoteChangedError: class extends Error {},
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore, editNeedsMask } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'
import type { CloudModel } from '../../lib/render/cloud-models'

const BILD = { filename: 'a.png', url: 'data:image/png;base64,AA', width: 512, height: 512 }
const MASKE = { filename: 'm.png', url: 'data:image/png;base64,MM', width: 512, height: 512 }

/** What the server sent before c341f5ac: every entry, none carries `maskless`. */
function katalogOhneMaskless(): CloudModel[] {
  return neuerServer().map((m) => {
    const { maskless: _m, ...rest } = m
    void _m
    return rest
  })
}

beforeEach(() => {
  submitted.length = 0; hochgeladen.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', source: BILD, mask: null, references: [],
    gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1,
  })
  useCreateStore.getState().setPrompt('a neutral placeholder line')
  useCreateStore.getState().setIntent('edit')
  useCloudCatalogStore.setState({ models: neuerServer() })
})

describe('Edit without a mask', () => {
  it('starts on an instruction editor and uploads no mask, even with a leftover painted one', async () => {
    useCreateStore.getState().setCloudImageModel('qwen-image-edit')
    useCreateStore.setState({ mask: MASKE })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].params.mask_path).toBeUndefined()
    expect(hochgeladen).not.toContain('mask')
  })

  it('starts on a studio editor without a mask', async () => {
    useCreateStore.getState().setCloudImageModel('qwen-image-2.1-edit')
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(hochgeladen).not.toContain('mask')
  })

  it('still asks for a mask on a masked editor and sends nothing', async () => {
    useCreateStore.getState().setCloudImageModel('flux-dev')
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toMatch(/Paint a mask first/)
    expect(submitted).toHaveLength(0)
  })

  it('a masked editor uploads the painted mask', async () => {
    useCreateStore.getState().setCloudImageModel('flux-dev')
    useCreateStore.setState({ mask: MASKE })
    await useCloudCreate().generate()
    expect(hochgeladen).toContain('mask')
    expect(submitted[0].params.mask_path).toBeTruthy()
  })
})

describe('A catalog without the maskless field (server before c341f5ac)', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: katalogOhneMaskless() }) })

  it('qwen-image-edit and the studio editors still take no mask, flux-dev still does', () => {
    expect(editNeedsMask('qwen-image-edit')).toBe(false)
    expect(editNeedsMask('qwen-image-2.1-edit')).toBe(false)
    expect(editNeedsMask('flux-dev')).toBe(true)
  })

  it('starts qwen-image-edit without a mask', async () => {
    useCreateStore.getState().setCloudImageModel('qwen-image-edit')
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
  })
})
