/**
 * Bug hunt 01.10.2026 (K7). Cancel on a job a GPU already took got a 409 from
 * the server, stopped the polling and said nothing. The job finished and was
 * charged, and the desktop has no job list to bring it back later. Now the
 * customer is told, and the poll keeps running so the result lands.
 */
import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

const hoisted = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, meta?: { code?: string }) {
      super(message)
      this.status = status
      this.code = meta?.code
    }
  }
  let release: (v: unknown) => void = () => {}
  return {
    FakeCloudJobError,
    release: (v: unknown) => release(v),
    submitCloudJob: vi.fn(async () => ({ id: 'job-run', quota: { cost: 1000, used: 1000, limit: 100000 } })),
    // Honours the abort signal like the real poll.
    pollJob: vi.fn((_id: string, opts?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      release = resolve
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })),
    cancelJob: vi.fn(async () => { throw new FakeCloudJobError('job is no longer cancelable', 409) }),
  }
})

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))
vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: vi.fn(),
  getJob: vi.fn(),
  submitCloudJob: hoisted.submitCloudJob,
  pollJob: hoisted.pollJob,
  cancelJob: hoisted.cancelJob,
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: class extends hoisted.FakeCloudJobError {},
}))
vi.mock('../../api/cloud/studio', () => ({ studioQuote: vi.fn(), StudioQuoteChangedError: class extends Error {} }))

import { useCloudCreate, RENDER_CANNOT_STOP } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({ isGenerating: false, error: null, backend: 'cloud', gallery: [], source: null })
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setPrompt('a lighthouse at dusk')
})

it('Cancel on a running job says it cannot stop, and the result still lands', async () => {
  const hook = useCloudCreate()
  const run = hook.generate()
  await vi.waitFor(() => expect(hoisted.pollJob).toHaveBeenCalled())
  await hook.cancel()
  expect(useCreateStore.getState().error).toBe(RENDER_CANNOT_STOP)
  hoisted.release({
    id: 'job-run', kind: 'image', model: 'flux-schnell', status: 'succeeded',
    result_url: 'https://storage.example/out.png', created_at: new Date().toISOString(),
  })
  await run
  expect(useCreateStore.getState().gallery.some((g) => g.jobId === 'job-run')).toBe(true)
})
