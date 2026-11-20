/**
 * Length billing (09.10.2026). The provider meters lip sync, voice and motion
 * by the length of what goes in. The server says so in the catalogue
 * (`credits.length`), measures the staged input itself, and
 *
 *   - books a start that names a ceiling (`max_credits`) up to that ceiling,
 *     and answers 409 quote_changed with the real price when it is higher;
 *   - books a start WITHOUT a ceiling only up to the catalogue figure and
 *     refuses a longer input ("This version of the app can start up to ...").
 *
 * Desktop 3.0.5 sent no ceiling on these runs. This build sends the figure on
 * its meter, and shows the server's own sentence when the server refuses.
 *
 * Nothing is rendered: submit and poll are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  class FakeQuoteChangedError extends FakeCloudJobError {
    credits: number
    constructor(message: string, credits: number) {
      super(message, 409, { code: 'quote_changed' })
      this.credits = credits
    }
  }
  const submitted: Array<{ kind: string; model: string; prompt: string; params: Record<string, unknown> }> = []
  const state: { refuse: null | ((payload: (typeof submitted)[number]) => Error | null) } = { refuse: null }
  return {
    FakeCloudJobError, FakeQuoteChangedError, submitted, state,
    uploadInput: vi.fn(async (_blob: unknown, slot: string) => `user-1/staged-${slot}`),
    getJob: vi.fn(async () => ({ id: 'voice-job', result_url: 'https://storage.example/voice.mp3' })),
    submitCloudJob: vi.fn(async (payload: (typeof submitted)[number]) => {
      submitted.push(payload)
      const refusal = state.refuse?.(payload)
      if (refusal) throw refusal
      return { id: 'job-test', quota: { cost: 1000, used: 1000, limit: 100000 } }
    }),
    pollJob: vi.fn(async () => ({
      id: 'job-test', kind: 'video', model: 'infinitetalk-fast', status: 'succeeded',
      result_url: 'https://storage.example/out.mp4', error: null, created_at: new Date().toISOString(),
    })),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    studioQuote: vi.fn(async () => ({ credits: 42 })),
  }
})
const { submitted, state } = hoisted

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
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore, lengthCredits, lengthPrice } from '../../stores/cloudCatalogStore'
import type { CloudModel } from '../../lib/render/cloud-models'

/** Shaped like /api/jobs/catalog since length billing: `base` is the price of
 *  `quote` units, `length` is the rule. */
const TALK: CloudModel = {
  id: 'infinitetalk-fast', label: 'InfiniteTalk Fast', kind: 'video', ops: ['lipsync'],
  credits: { base: 15_000, length: { basis: 'audio', block: 1, per_block: 1_500, min: 3, max: 600, quote: 10 } },
} as CloudModel
const VOICE = (id: string): CloudModel => ({
  id, label: id, kind: 'audio', ops: ['tts'],
  credits: { base: 2_500, length: { basis: 'chars', block: 100, per_block: 500, min: 1, max: 4000, quote: 500 } },
} as CloudModel)
/** The same models from a server before length billing: no `length`. */
const old = (m: CloudModel): CloudModel => ({ ...m, credits: { base: m.credits!.base } })

const blob = new Blob(['x'])
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function stage(models: CloudModel[]) {
  useCloudCatalogStore.setState({ models })
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', improvePrompt: false, mask: null,
    gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1,
    source: { url: PNG, name: 'face.png' }, audioInput: { url: 'blob:audio', name: 'line.mp3', blob },
    videoInput: null, voiceFromJob: null,
  } as never)
  useCreateStore.getState().setIntent('lipsync')
  useCreateStore.getState().setCloudOpModel('infinitetalk-fast')
  useCreateStore.getState().setPrompt('')
}

beforeEach(() => {
  submitted.length = 0
  state.refuse = null
})

describe('the rule of the catalogue', () => {
  beforeEach(() => stage([TALK, VOICE('qwen3-tts'), VOICE('qwen3-tts-design')]))

  it('prices the real length: whole units, never below the minimum, never above the maximum', () => {
    expect(lengthCredits('infinitetalk-fast')).toBe(15_000) // the catalogue length, 10 s
    expect(lengthCredits('infinitetalk-fast', 0.4)).toBe(4_500) // the provider bills at least 3 s
    expect(lengthCredits('infinitetalk-fast', 42.2)).toBe(64_500) // 43 started seconds
    expect(lengthCredits('infinitetalk-fast', 9_999)).toBe(900_000) // the server takes no more than 600 s
    expect(lengthCredits('qwen3-tts', 1)).toBe(500) // one started block of 100 characters
    expect(lengthCredits('qwen3-tts', 100)).toBe(500)
    expect(lengthCredits('qwen3-tts', 101)).toBe(1_000)
    expect(lengthCredits('qwen3-tts')).toBe(2_500) // 500 characters, the catalogue figure
  })

  it('asks only where the provider can meter by length', () => {
    expect(lengthPrice('infinitetalk-fast', 'lipsync')?.basis).toBe('audio')
    expect(lengthPrice('infinitetalk-fast')?.quote).toBe(10)
    expect(lengthPrice('infinitetalk-fast', 'generate')).toBeUndefined()
    expect(lengthPrice('no-such-model', 'lipsync')).toBeUndefined()
    expect(lengthPrice(undefined, 'lipsync')).toBeUndefined()
  })

  it('a server from before length billing: no rule, the catalogue figure is the price', () => {
    stage([old(TALK), old(VOICE('qwen3-tts'))])
    expect(lengthPrice('infinitetalk-fast', 'lipsync')).toBeUndefined()
    expect(lengthCredits('infinitetalk-fast', 42)).toBe(15_000)
    expect(lengthCredits('qwen3-tts', 3000)).toBe(2_500)
  })
})

describe('a lip sync run', () => {
  beforeEach(() => stage([TALK]))

  it('sends the figure on the meter as its ceiling', async () => {
    // What the Composer stored after measuring 43 s of audio.
    useCreateStore.getState().setCloudStudioCredits(64_500)
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].model).toBe('infinitetalk-fast')
    expect(submitted[0].params.op).toBe('lipsync')
    expect(submitted[0].params.max_credits).toBe(64_500)
    // A classic model is never asked for a studio quote.
    expect(hoisted.studioQuote).not.toHaveBeenCalled()
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('before the meter has measured, the ceiling is the catalogue figure, never nothing', async () => {
    await useCloudCreate().generate()
    expect(submitted[0].params.max_credits).toBe(15_000)
  })

  it('the server measured more: its price is shown, nothing is booked, the second click carries it', async () => {
    useCreateStore.getState().setCloudStudioCredits(15_000)
    state.refuse = (p) => (Number(p.params.max_credits) < 64_500
      ? new hoisted.FakeQuoteChangedError('The price has changed. Review the new quote before starting.', 64_500)
      : null)
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('The price changed to 64,500 credits. Review it, then hit Create again.')
    expect(useCreateStore.getState().cloudStudioCredits).toBe(64_500)
    expect(useCreateStore.getState().gallery).toHaveLength(0)

    await useCloudCreate().generate()
    expect(submitted).toHaveLength(2)
    expect(submitted[1].params.max_credits).toBe(64_500)
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('an input the model does not take: the sentence of the server, as it comes', async () => {
    const sentence = 'This model takes up to 600 seconds. Yours has 742. No credits were charged.'
    state.refuse = () => new hoisted.FakeCloudJobError(sentence, 400, { code: 'input_too_long' })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe(sentence)
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('a server from before length billing gets the run as it always did, without a ceiling', async () => {
    stage([old(TALK)])
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect('max_credits' in submitted[0].params).toBe(false)
  })
})

describe('the voice maker', () => {
  it('sends the price of its characters as the ceiling', async () => {
    stage([TALK, VOICE('qwen3-tts'), VOICE('qwen3-tts-design')])
    await useCloudCreate().makeVoice({ text: 'x'.repeat(1_234), mode: 'speak', voice: 'Vivian' })
    expect(submitted[0].model).toBe('qwen3-tts')
    expect(submitted[0].params.max_credits).toBe(6_500) // 13 started blocks of 100
    await useCloudCreate().makeVoice({ text: 'short', mode: 'design', description: 'warm narrator' })
    expect(submitted[1].model).toBe('qwen3-tts-design')
    expect(submitted[1].params.max_credits).toBe(500)
  })

  it('counts characters, not UTF-16 units', async () => {
    stage([VOICE('qwen3-tts')])
    await useCloudCreate().makeVoice({ text: '😀'.repeat(100), mode: 'speak' })
    expect(submitted[0].params.max_credits).toBe(500)
  })

  it('a server from before length billing: no ceiling, as before', async () => {
    stage([old(VOICE('qwen3-tts'))])
    await useCloudCreate().makeVoice({ text: 'x'.repeat(1_234), mode: 'speak' })
    expect('max_credits' in submitted[0].params).toBe(false)
  })
})
