/**
 * Fund F6 (05.10.2026) sitzt in der Web-API: ein gescheiterter Auftrag kommt
 * als schlichter englischer Satz ohne den Namen eines Anbieters zurueck. Der
 * Desktop zeigt diesen Satz, wie er kommt, und schreibt selbst nichts dazu.
 *
 * Nichts wird erzeugt: Absenden und Abholen sind gemockt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

// A full, hand-written mock (no `...actual` spread): the real ../../api/cloud/jobs
// pulls in the Supabase client (api/cloud/supabase.ts), which touches
// `localStorage` at import time and blows up outside a browser-like test
// environment. The established pattern in this directory (see
// useCloudCreate-b3-adult-gate-fires-before-upload.test.ts) is a fake
// CloudJobError/QuoteChangedError pair instead of the real classes.
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
  class FakeQuoteChangedError extends FakeCloudJobError {
    credits: number
    constructor(message: string, credits: number) {
      super(message, 409, { code: 'quote_changed' })
      this.credits = credits
    }
  }
  const submitted: Array<{ kind: string; model: string; prompt: string; params: Record<string, unknown> }> = []
  const hochgeladen: string[] = []
  return {
    FakeCloudJobError,
    FakeQuoteChangedError,
    submitted,
    hochgeladen,
    uploadInput: vi.fn(async (_blob: unknown, slot: string) => {
      hochgeladen.push(slot)
      return `user-1/staged-${slot}.${slot === 'audio' ? 'mp3' : slot === 'video' ? 'mp4' : 'png'}`
    }),
    getJob: vi.fn(async () => ({ id: 'quelle', result_url: 'https://storage.example/clip.mp4' })),
    submitCloudJob: vi.fn(async (payload: (typeof submitted)[number]) => {
      submitted.push(payload)
      return { id: 'job-test', quota: { cost: 1000, used: 1000, limit: 100000 } }
    }),
    pollJob: vi.fn(async () => ({
      id: 'job-test', kind: 'image', model: 'flux-schnell', status: 'failed', result_url: null,
      error: 'The render failed. No credits were charged. Try again or pick another model.',
      created_at: new Date().toISOString(),
    })),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    studioQuote: vi.fn(async (..._args: unknown[]) => ({ credits: 42 })),
  }
})
const { submitted, hochgeladen } = hoisted

// Sidesteps loadContentPolicy's own call into ../../api/cloud/jobs
// (getContentPolicy). 'off' keeps clientSafety() to its CSAM-only floor,
// same as an account whose policy has not loaded yet.
vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))

vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: hoisted.uploadInput,
  getJob: hoisted.getJob,
  submitCloudJob: hoisted.submitCloudJob,
  pollJob: hoisted.pollJob,
  cancelJob: hoisted.cancelJob,
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChangedError,
}))

// A Studio run confirms its price right before booking (useCloudCreate.ts,
// the "Confirming the price…" step). The quote is asked with the run's prompt.
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

const SATZ = 'The render failed. No credits were charged. Try again or pick another model.'

beforeEach(() => {
  submitted.length = 0
  hochgeladen.length = 0
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', improvePrompt: false, source: null, mask: null,
    gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1,
  })
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setCloudImageModel('flux-schnell')
  useCreateStore.getState().setPrompt('a quiet harbour at dawn')
})

describe('ein gescheiterter Cloud-Auftrag', () => {
  it('zeigt den Satz des Servers unveraendert, ohne Zusatz und ohne Anbieternamen', async () => {
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect(useCreateStore.getState().error).toBe(SATZ)
    expect(useCreateStore.getState().gallery).toHaveLength(0)
  })
})
