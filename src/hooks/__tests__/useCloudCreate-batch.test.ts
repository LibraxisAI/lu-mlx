/**
 * Several source images, one edit, in the cloud: what is sent and what is
 * booked. The real generate() and the real batch run, with submit, upload,
 * poll and cancel mocked. Nothing is rendered and nothing is charged.
 *
 * The rule under test: every image is its own run with its own booking, and an
 * image that never starts is never uploaded and never submitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

type Payload = { kind: string; model: string; prompt: string; params: Record<string, unknown> }
const hoisted = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    code?: string
    retryAfterMs?: number
    constructor(message: string, status: number, meta?: { code?: string; retryAfterMs?: number }) {
      super(message)
      this.status = status
      this.code = meta?.code
      this.retryAfterMs = meta?.retryAfterMs
    }
  }
  class FakeQuoteChanged extends FakeCloudJobError {
    credits: number
    constructor(message: string, credits: number) {
      super(message, 409, { code: 'quote_changed' })
      this.credits = credits
    }
  }
  return {
    FakeCloudJobError,
    FakeQuoteChanged,
    plan: {
      /** What the n-th submit does instead of booking (1-based). */
      refuse: {} as Record<number, () => Error>,
      /** Job ids whose render fails. */
      failed: new Set<string>(),
      /** Called when a job is polled, to act in the middle of a run. */
      onPoll: null as null | ((id: string) => void | Promise<void>),
      upload: 0,
    },
    submitted: [] as Payload[],
    booked: [] as string[],
    uploaded: [] as string[],
    cancelled: [] as string[],
    quote: vi.fn(async (..._a: unknown[]) => ({ credits: 5000 })),
  }
})
const { submitted, booked, uploaded, cancelled, plan } = hoisted

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))
vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: vi.fn(async (_b: unknown, slot: string) => { const p = `user-1/staged-${slot}-${++plan.upload}.png`; uploaded.push(p); return p }),
  getJob: vi.fn(),
  cancelJob: vi.fn(async (id: string) => { cancelled.push(id); return { status: 'canceled' } }),
  submitCloudJob: vi.fn(async (payload: Payload) => {
    submitted.push(payload)
    const refuse = plan.refuse[submitted.length]
    if (refuse) throw refuse()
    const asked = (payload.params.count as number | undefined) ?? 1
    const ids = Array.from({ length: asked }, (_, i) => `job-${submitted.length}-${i}`)
    booked.push(...ids)
    if (asked === 1) return { id: ids[0], quota: { cost: 300 } }
    return { id: ids[0], quota: { cost: 300 }, jobs: ids.map((id) => ({ id, status: 'queued', cost: 300 })), requested: asked }
  }),
  pollJob: vi.fn(async (id: string, opts: { signal?: AbortSignal }) => {
    await plan.onPoll?.(id)
    if (opts.signal?.aborted) throw new hoisted.FakeCloudJobError('polling aborted', 0)
    const status = plan.failed.has(id) ? 'failed' : 'succeeded'
    return {
      id, kind: 'image', model: 'flux-schnell', status,
      result_url: status === 'succeeded' ? `https://storage.example/${id}.png` : null,
      error: status === 'failed' ? 'provider said no' : null,
      created_at: new Date().toISOString(), params: {},
    }
  }),
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChanged,
}))
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.quote,
  StudioQuoteChangedError: hoisted.FakeQuoteChanged,
}))
// No FileReader and no ComfyUI in this run: a file becomes a data URL that
// carries its name, so the test can see which image was uploaded.
vi.mock('../../components/create/experimental/loadImage', () => ({
  loadImageRef: vi.fn(async (f: File) => ({ filename: '', url: `data:image/png;base64,${btoa(f.name)}`, width: 64, height: 64 })),
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'
import {
  addBatchFiles, batchReady, requestBatchStop, runBatchEdit,
} from '../../components/create/experimental/batchRun'

const png = (name: string) => new File([name], name, { type: 'image/png' })
const noSleep = { sleep: async () => {} }
const names = () => useCreateStore.getState().batchSources.map((b) => b.name)

async function stage(intent: 'edit' | 'removebg' | 'upscale', files: string[]) {
  useCreateStore.getState().setIntent(intent)
  await addBatchFiles(files.map(png))
}

beforeEach(() => {
  submitted.length = 0; booked.length = 0; uploaded.length = 0; cancelled.length = 0
  plan.refuse = {}; plan.failed.clear(); plan.onPoll = null; plan.upload = 0
  hoisted.quote.mockClear()
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', source: null, mask: null, references: [],
    batchSources: [], batchRun: null,
    gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1,
  })
  useCreateStore.getState().setPrompt('a neutral placeholder line')
  useCloudCatalogStore.setState({ models: neuerServer() })
})

describe('each image is its own run and its own booking', () => {
  it('three images: three uploads, three submits, three results tied to their file', async () => {
    await stage('removebg', ['c.png', 'a.png', 'b.png'])
    expect(names()).toEqual(['a.png', 'b.png', 'c.png'])
    expect(batchReady()).toBe(true)

    await runBatchEdit(useCloudCreate().generate, noSleep)

    expect(submitted).toHaveLength(3)
    expect(submitted.every((p) => p.params.op === 'removebg' && p.params.count === undefined)).toBe(true)
    // Its own request id and its own staged source per image.
    expect(new Set(submitted.map((p) => p.params.client_request_id)).size).toBe(3)
    expect(submitted.map((p) => p.params.source_path)).toEqual(uploaded)
    expect(new Set(uploaded).size).toBe(3)
    expect(booked).toHaveLength(3)

    const s = useCreateStore.getState()
    expect(s.gallery.map((g) => g.sourceName).sort()).toEqual(['a.png', 'b.png', 'c.png'])
    // A cutout has no prompt: the name of the run is its label, and the text
    // left in the prompt field of another view is not written onto it.
    expect(s.gallery.map((g) => [g.prompt, g.label])).toEqual(Array(3).fill(['', 'Background removed']))
    expect(s.batchSources).toEqual([])
    expect(s.batchRun).toBeNull()
    expect(s.error).toBeNull()
    expect(s.isGenerating).toBe(false)
  })

  it('Edit with two results per image: every image asks for its own two', async () => {
    useCreateStore.getState().setCloudImageModel('qwen-image-edit')
    await stage('edit', ['a.png', 'b.png'])
    useCreateStore.getState().setCloudImageCount(2)

    await runBatchEdit(useCloudCreate().generate, noSleep)

    expect(submitted).toHaveLength(2)
    expect(submitted.map((p) => p.params.count)).toEqual([2, 2])
    expect(submitted.every((p) => p.params.mask_path === undefined)).toBe(true)
    expect(booked).toHaveLength(4)
    const made = useCreateStore.getState().gallery
    expect(made.filter((g) => g.sourceName === 'a.png')).toHaveLength(2)
    expect(made.filter((g) => g.sourceName === 'b.png')).toHaveLength(2)
  })
})

describe('credits cover only a part', () => {
  it('the refused image and everything behind it is never booked, never sent', async () => {
    await stage('removebg', ['a.png', 'b.png', 'c.png', 'd.png'])
    plan.refuse[3] = () => new hoisted.FakeCloudJobError('credits exhausted', 429, { code: 'credits_exhausted' })

    await runBatchEdit(useCloudCreate().generate, noSleep)

    // Two booked, the third asked and refused, the fourth never left the app.
    expect(booked).toHaveLength(2)
    expect(submitted).toHaveLength(3)
    expect(uploaded).toHaveLength(3)
    const s = useCreateStore.getState()
    expect(s.gallery).toHaveLength(2)
    expect(names()).toEqual(['c.png', 'd.png'])
    expect(s.error).toBe(
      '2 of 4 images are done. There were not enough credits to go on. The other 2 were not started and nothing was charged for them. ' +
      'What is left stays ready, hit Create to run it.',
    )
  })

  it('a second Create runs exactly what is left, nothing twice', async () => {
    await stage('removebg', ['a.png', 'b.png', 'c.png', 'd.png'])
    plan.refuse[3] = () => new hoisted.FakeCloudJobError('credits exhausted', 429, { code: 'credits_exhausted' })
    await runBatchEdit(useCloudCreate().generate, noSleep)
    plan.refuse = {}
    expect(booked).toHaveLength(2)

    await runBatchEdit(useCloudCreate().generate, noSleep)

    // Two more bookings, for c.png and d.png only.
    expect(booked).toHaveLength(4)
    expect(submitted).toHaveLength(5)
    expect(useCreateStore.getState().gallery.map((g) => g.sourceName).sort()).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    expect(useCreateStore.getState().batchSources).toEqual([])
  })
})

describe('one image fails', () => {
  it('the others still run, and the failed file is named at the end', async () => {
    await stage('removebg', ['a.png', 'b.png', 'c.png'])
    plan.failed.add('job-2-0')

    await runBatchEdit(useCloudCreate().generate, noSleep)

    expect(submitted).toHaveLength(3)
    const s = useCreateStore.getState()
    expect(s.gallery.map((g) => g.sourceName).sort()).toEqual(['a.png', 'c.png'])
    expect(s.error).toBe('2 of 3 images are done. 1 failed: b.png. Error: provider said no. What is left stays ready, hit Create to run it.')
    // One image left is the plain single source again.
    expect(s.batchSources).toEqual([])
    expect(atob(s.source!.url.split(',')[1])).toBe('b.png')
  })
})

describe('Cancel', () => {
  it('stops the run in flight and nothing behind it starts', async () => {
    await stage('removebg', ['a.png', 'b.png', 'c.png', 'd.png'])
    const cloud = useCloudCreate()
    plan.onPoll = async (id) => {
      if (id !== 'job-2-0') return
      requestBatchStop()
      await cloud.cancel()
    }

    await runBatchEdit(cloud.generate, noSleep)

    expect(submitted).toHaveLength(2)
    expect(uploaded).toHaveLength(2)
    expect(cancelled).toEqual(['job-2-0'])
    const s = useCreateStore.getState()
    expect(s.gallery).toHaveLength(1)
    expect(names()).toEqual(['b.png', 'c.png', 'd.png'])
    expect(s.error).toBe('1 of 4 images are done. Stopped. The other 3 were not started. What is left stays ready, hit Create to run it.')
  })
})

describe('the send limit', () => {
  it('"too fast" waits as the server asked and sends the same image again, booked once', async () => {
    await stage('removebg', ['a.png', 'b.png'])
    plan.refuse[1] = () => new hoisted.FakeCloudJobError('too many submissions', 429, { retryAfterMs: 20_000 })
    const slept: number[] = []

    await runBatchEdit(useCloudCreate().generate, { sleep: async (ms) => { slept.push(ms) } })

    expect(slept).toEqual([20_000])
    expect(submitted).toHaveLength(3)
    expect(booked).toHaveLength(2)
    expect(useCreateStore.getState().gallery.map((g) => g.sourceName).sort()).toEqual(['a.png', 'b.png'])
    expect(useCreateStore.getState().error).toBeNull()
  })
})

describe('a model that needs a mask', () => {
  it('never runs as a batch, the list waits for a model without a mask', async () => {
    useCreateStore.getState().setCloudImageModel('qwen-image-edit')
    await stage('edit', ['a.png', 'b.png'])
    expect(batchReady()).toBe(true)
    useCreateStore.getState().setCloudImageModel('flux-dev')
    expect(batchReady()).toBe(false)
  })

  it('Erase Object takes one image, and adding files there makes no list', async () => {
    useCreateStore.getState().setIntent('eraser')
    expect(batchReady()).toBe(false)
  })
})

describe('the list itself', () => {
  it('takes 50 images at most and says so', async () => {
    useCreateStore.getState().setIntent('removebg')
    await addBatchFiles(Array.from({ length: 53 }, (_, i) => png(`f${String(i).padStart(2, '0')}.png`)))
    const s = useCreateStore.getState()
    expect(s.batchSources).toHaveLength(50)
    expect(s.error).toBe('You can edit up to 50 images at once. 50 were added, 3 were left out.')
    await addBatchFiles([png('late.png')])
    expect(useCreateStore.getState().batchSources).toHaveLength(50)
    expect(useCreateStore.getState().error).toBe('The list is full. You can edit up to 50 images at once.')
  })

  it('leaving the tab drops the list, so nothing runs later by surprise', async () => {
    await stage('removebg', ['a.png', 'b.png'])
    useCreateStore.getState().setIntent('image')
    expect(useCreateStore.getState().batchSources).toEqual([])
    expect(batchReady()).toBe(false)
  })

  it('a changed tab in the middle of a run ends it before the next image', async () => {
    await stage('removebg', ['a.png', 'b.png', 'c.png'])
    plan.onPoll = (id) => { if (id === 'job-1-0') useCreateStore.getState().setIntent('image') }
    await runBatchEdit(useCloudCreate().generate, noSleep)
    expect(submitted).toHaveLength(1)
    expect(booked).toHaveLength(1)
  })
})
