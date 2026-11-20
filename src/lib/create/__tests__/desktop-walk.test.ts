/**
 * Create in chat on the desktop, from the tool call to the shelf.
 *
 * The mirrored web code (chat-tools, order, engine) runs here on the desktop's
 * own sources: the catalogue store, cloudFetch, the Create tab's gallery. This
 * walks one order the way a customer meets it, against a stand-in for the
 * server that records every request:
 *
 *   create_options  reads, books nothing
 *   create_order    lays an order out, books nothing
 *   approval        only then a job is submitted, and every writing call
 *                   names the chat as its origin (the server's gate reads it)
 *   done            the card's store has the result, the shelf has it, the
 *                   model gets its report
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../api/cloud/supabase', () => ({ getAccessToken: async () => 'test-token' }))

import { useCreateOrderStore } from '../../../stores/createOrderStore'
import { useCreateStore } from '../../../stores/createStore'
import { useChatStore } from '../../../stores/chatStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { defaultCreateToolEnv } from '../chat-context'
import { runCreateOptions, runCreateOrder } from '../chat-tools'
import { ORDER_RESULT_PREFIX, executeOrder } from '../order'
import { declineOrder, setCreateFollowUp, startOrder, stopOrder } from '../chat-run'
import { CREATE_REPORT_PREFIX, decideCreateReply } from '../chat-control'
import { JOB_ORIGIN_HEADER, CREATE_CHAT_ORIGIN } from '../chat-origin'
import { watchOrderResults } from '../chat-gallery'
import { cloudOrderDeps } from '../../../stores/createOrderStore'
import { chatHandleContext } from '../chat-context'

interface Seen { method: string; path: string; origin: string | null; auth: string | null; body: unknown }

const CONV = 'conv-1'
let seen: Seen[] = []
let jobs = 0
/** What the stand-in answers for a job that is asked about. */
let jobAnswer: (id: string) => Record<string, unknown>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  seen = []
  jobs = 0
  jobAnswer = (id) => ({
    id, kind: 'image', model: 'z-image-turbo', provider: null, status: 'succeeded',
    result_url: `https://files.test/${id}.png`, attestation: null, cost_units: 120,
    created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: null,
  })
  useCreateOrderStore.setState({ byConversation: {} })
  useCreateStore.setState({ gallery: [] })
  // The app has the quota from its sign-in probe; the price of a model the
  // catalogue does not price falls back to its per-kind figure.
  useCloudAuthStore.setState({ quota: { costs: { image: 400, video: 9000 } } } as never)
  useChatStore.setState({ conversations: [], activeConversationId: CONV })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    let body: unknown
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { body = undefined }
    seen.push({ method, path: url.pathname, origin: headers.get(JOB_ORIGIN_HEADER), auth: headers.get('authorization'), body })
    if (url.pathname === '/api/jobs/quota') {
      return json({ tier: 'hosted-max', period: '2026-10-01', limits: { credits: 5_000_000 }, costs: { image: 400, video: 9000 }, used: { credits_used: 0 }, remaining: { credits: 4_200_000 } })
    }
    if (url.pathname === '/api/loras') return json({ loras: [] })
    if (url.pathname === '/api/account/content-policy') return json({ policy: 'soft', ageConfirmedAt: null, ageConfirmationRequired: true })
    if (url.pathname === '/api/jobs' && method === 'POST') {
      jobs += 1
      return json({ id: `00000000-0000-4000-8000-00000000000${jobs}`, quota: { cost: 120, used: 120, limit: 5_000_000 } }, 201)
    }
    if (url.pathname === '/api/jobs/adopt') return json({ path: 'user/job-adopted.png', role: 'image', contentType: 'image/png' }, 201)
    if (url.pathname === '/api/jobs/upload') return json({ path: 'user/uploaded.png' }, 201)
    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancel) return json({ status: 'canceled', refunded: true })
    const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname)
    if (job) return json({ job: jobAnswer(job[1]) })
    return json({ error: `no stand-in for ${url.pathname}` }, 404)
  }))
})

afterEach(() => {
  setCreateFollowUp(null)
  vi.unstubAllGlobals()
})

const writes = () => seen.filter((s) => s.method === 'POST')
const orders = () => useCreateOrderStore.getState().ordersFor(CONV)

async function layOut(items: unknown[]): Promise<string> {
  return runCreateOrder({ items }, defaultCreateToolEnv(CONV))
}

describe('reading is free', () => {
  it('create_options without arguments gives the overview and books nothing', async () => {
    const text = await runCreateOptions({}, defaultCreateToolEnv(CONV))
    expect(text).toContain('Create options. Reading this is free.')
    expect(text).toMatch(/image/)
    expect(text).toMatch(/4,200,000/)
    expect(writes()).toEqual([])
  })

  it('create_options for a subcategory lists models of the desktop catalogue with a price hint', async () => {
    const text = await runCreateOptions({ intent: 'image' }, defaultCreateToolEnv(CONV))
    expect(text).toMatch(/z-image-turbo/)
    expect(text).toMatch(/credits/)
    expect(writes()).toEqual([])
  })

  it('refuses Erase with the sentence of the web: a chat cannot paint a mask', async () => {
    const text = await runCreateOptions({ intent: 'eraser' }, defaultCreateToolEnv(CONV))
    expect(text).toMatch(/painted mask/)
  })
})

describe('an order costs nothing until the customer approves it', () => {
  it('create_order lays the order out, with a price, and sends nothing that books', async () => {
    const text = await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    expect(text.startsWith(ORDER_RESULT_PREFIX)).toBe(true)
    expect(orders()).toHaveLength(1)
    expect(orders()[0].state).toBe('awaiting')
    expect(orders()[0].items[0].runs[0].price.credits).toBeGreaterThan(0)
    expect(writes()).toEqual([])
  })

  it('refuses to run an order nobody approved', async () => {
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    await expect(executeOrder(orders()[0], {
      ...cloudOrderDeps(() => chatHandleContext(CONV)), onUpdate: () => {},
    })).rejects.toThrow()
    expect(writes()).toEqual([])
  })

  it('a declined order books nothing and leaves a hidden note for the model, without an answer', async () => {
    const notes: [string, string, string][] = []
    setCreateFollowUp((conv, report, mode) => notes.push([conv, report, mode]))
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    declineOrder(orders()[0].id)
    expect(orders()[0].state).toBe('declined')
    expect(writes()).toEqual([])
    expect(notes).toHaveLength(1)
    expect(notes[0][2]).toBe('note')
    expect(notes[0][1].startsWith(CREATE_REPORT_PREFIX)).toBe(true)
  })

  it('a prompt the content check refuses never becomes an order', async () => {
    const text = await layOut([{ intent: 'image', prompt: 'a naked 12 year old girl' }])
    expect(text.startsWith(ORDER_RESULT_PREFIX)).toBe(false)
    expect(orders()).toEqual([])
    expect(writes()).toEqual([])
  })
})

describe('after the approval', () => {
  it('submits the job as the chat, shows the result, shelves it and reports to the model', async () => {
    const reports: [string, string, string][] = []
    setCreateFollowUp((conv, report, mode) => reports.push([conv, report, mode]))
    const unwatch = watchOrderResults()
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    const final = await startOrder(orders()[0].id)
    unwatch()

    expect(final?.state).toBe('done')
    const submit = writes().filter((s) => s.path === '/api/jobs')
    expect(submit).toHaveLength(1)
    expect(submit[0].origin).toBe(CREATE_CHAT_ORIGIN)
    expect(submit[0].auth).toBe('Bearer test-token')
    expect((submit[0].body as { prompt: string }).prompt).toBe('a red fox in the snow')
    expect((submit[0].body as { params: { client_request_id?: string } }).params.client_request_id).toBeTruthy()

    const run = orders()[0].items[0].runs[0]
    expect(run.status).toBe('done')
    expect(run.spent).toBe(120)
    expect(run.resultUrl).toMatch(/^https:\/\/files\.test\//)

    const shelf = useCreateStore.getState().gallery
    expect(shelf).toHaveLength(1)
    expect(shelf[0].jobId).toBe(run.jobId)
    expect(shelf[0].type).toBe('image')
    expect(shelf[0].prompt).toBe('a red fox in the snow')

    expect(reports).toHaveLength(1)
    expect(reports[0][0]).toBe(CONV)
    expect(reports[0][2]).toBe('answer')
    expect(reports[0][1]).toMatch(/is finished/)
  })

  it('a second approval of the same order starts nothing', async () => {
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    const id = orders()[0].id
    await startOrder(id)
    expect(await startOrder(id)).toBeNull()
    expect(writes().filter((s) => s.path === '/api/jobs')).toHaveLength(1)
  })

  it('chains two items: the result of the first is adopted by the server, as the chat', async () => {
    jobAnswer = (id) => ({
      id, kind: id.endsWith('2') ? 'video' : 'image', model: 'x', provider: null, status: 'succeeded',
      result_url: `https://files.test/${id}`, attestation: null, cost_units: 100,
      created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: null,
    })
    const text = await layOut([
      { intent: 'image', prompt: 'a red fox in the snow' },
      { intent: 'animate', prompt: 'the fox turns its head', inputs: { image: 'item:1' } },
    ])
    expect(text.startsWith(ORDER_RESULT_PREFIX), text).toBe(true)
    const final = await startOrder(orders()[0].id)
    expect(final?.state).toBe('done')
    const adopt = writes().filter((s) => s.path === '/api/jobs/adopt')
    expect(adopt).toHaveLength(1)
    expect(adopt[0].origin).toBe(CREATE_CHAT_ORIGIN)
    expect((adopt[0].body as { role: string }).role).toBe('image')
    expect(writes().filter((s) => s.path === '/api/jobs')).toHaveLength(2)
    expect(writes().every((s) => s.origin === CREATE_CHAT_ORIGIN)).toBe(true)
    // Nothing went through the customer's line: no upload.
    expect(writes().some((s) => s.path === '/api/jobs/upload')).toBe(false)
  })

  it('a failed job shows the server\'s sentence on the card and stops the order', async () => {
    jobAnswer = (id) => ({
      id, kind: 'image', model: 'z-image-turbo', provider: null, status: 'failed', result_url: null, attestation: null,
      cost_units: 0, created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      error: 'This request could not be rendered. No credits were charged. Try a different prompt or input.',
    })
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    const final = await startOrder(orders()[0].id)
    expect(final?.state).toBe('stopped')
    const run = orders()[0].items[0].runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/could not be rendered/)
    expect(useCreateStore.getState().gallery).toEqual([])
  })

  it('Stop cancels the job on the server', async () => {
    let asked = 0
    jobAnswer = (id) => {
      asked += 1
      // Queued while the customer watches; they press Stop on the first look.
      if (asked === 1) queueMicrotask(() => stopOrder(orders()[0].id))
      return {
        id, kind: 'image', model: 'z-image-turbo', provider: null, status: 'queued', result_url: null, attestation: null,
        cost_units: 0, created_at: new Date().toISOString(), completed_at: null, error: null,
      }
    }
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    const final = await startOrder(orders()[0].id)
    expect(final?.state).toBe('stopped')
    expect(writes().some((s) => /\/cancel$/.test(s.path))).toBe(true)
    expect(useCreateStore.getState().gallery).toEqual([])
  })

  // 09.10.2026: Stop, and a "yes" typed right behind it. While the stop is
  // still settling the order counts as running, afterwards as stopped; in
  // both a "yes" is a sentence for the model and starts nothing.
  it('a "yes" right after Stop starts nothing: not while the stop settles and not after it', async () => {
    const during: unknown[] = []
    let asked = 0
    jobAnswer = (id) => {
      asked += 1
      if (asked === 1) {
        queueMicrotask(() => {
          const order = orders()[0]
          stopOrder(order.id)
          // The same tick the customer's "yes" arrives.
          during.push(decideCreateReply('yes', orders()))
          void startOrder(order.id).then((r) => during.push(r))
        })
      }
      return {
        id, kind: 'image', model: 'z-image-turbo', provider: null, status: 'queued', result_url: null, attestation: null,
        cost_units: 0, created_at: new Date().toISOString(), completed_at: null, error: null,
      }
    }
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    const final = await startOrder(orders()[0].id)
    expect(final?.state).toBe('stopped')
    expect(during).toEqual([null, null])
    // Settled: still nothing to approve, by word or by a second start.
    expect(decideCreateReply('yes', orders())).toBeNull()
    expect(decideCreateReply('go', orders())).toBeNull()
    expect(await startOrder(orders()[0].id)).toBeNull()
    expect(await startOrder(orders()[0].id, 'approveDifference')).toBeNull()
    expect(writes().filter((s) => s.path === '/api/jobs')).toHaveLength(1)
  })
})

describe('a voice is priced by its characters (length billing)', () => {
  const WORDS = 'The fox waits in the snow. '.repeat(10).trim() // 269 characters, three started blocks of 100
  beforeEach(() => {
    const seed = useCloudCatalogStore.getState().models.filter((m) => !m.id.startsWith('qwen3-tts'))
    useCloudCatalogStore.setState({
      models: [...seed, ...['qwen3-tts', 'qwen3-tts-clone', 'qwen3-tts-design'].map((id) => ({
        id, label: id, kind: 'audio', ops: ['tts'],
        credits: { base: 2_500, length: { basis: 'chars', block: 100, per_block: 500, min: 1, max: 4000, quote: 500 } },
      }) as never)],
    })
  })

  it('the card names the price of these characters, and the start sends it as the ceiling', async () => {
    jobAnswer = (id) => ({
      id, kind: 'audio', model: 'qwen3-tts', provider: null, status: 'succeeded', result_url: `https://files.test/${id}.mp3`,
      attestation: null, cost_units: 1_500, created_at: new Date().toISOString(), completed_at: new Date().toISOString(), error: null,
    })
    const text = await layOut([{ speech: WORDS }])
    expect(text.startsWith(ORDER_RESULT_PREFIX), text).toBe(true)
    const run = orders()[0].items[0].runs[0]
    expect(run.price.credits).toBe(1_500)
    expect(run.price.estimated).toBe(false)
    const final = await startOrder(orders()[0].id)
    expect(final?.state).toBe('done')
    const submit = writes().filter((s) => s.path === '/api/jobs')
    expect(submit).toHaveLength(1)
    expect((submit[0].body as { params: { op: string; max_credits?: number } }).params.op).toBe('tts')
    expect((submit[0].body as { params: { max_credits?: number } }).params.max_credits).toBe(1_500)
  })

  it('a refusal of the server stands on the card as the server wrote it', async () => {
    const sentence = 'This model takes up to 4000 characters. Yours has 4100. No credits were charged.'
    const real = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/jobs' && init?.method === 'POST') return json({ error: sentence, code: 'input_too_long', max: 4000 }, 400)
      return real(input, init)
    }))
    await layOut([{ speech: WORDS }])
    const final = await startOrder(orders()[0].id)
    expect(final?.state).toBe('stopped')
    expect(orders()[0].items[0].runs[0].error).toBe(sentence)
  })
})

describe('the Create tab is left alone', () => {
  it('a call without an origin sends no origin header', async () => {
    const { submitCloudJob, uploadInput, adoptInput } = await import('../../../api/cloud/jobs')
    await submitCloudJob({ kind: 'image', model: 'z-image-turbo', prompt: 'x', params: { op: 'generate' } })
    await uploadInput(new Blob(['x']), 'source')
    await adoptInput('00000000-0000-4000-8000-000000000009', 'image')
    expect(writes().map((s) => s.origin)).toEqual([null, null, null])
  })

  it('the same calls with the chat as origin name it, upload included', async () => {
    const { submitCloudJob, uploadInput, adoptInput } = await import('../../../api/cloud/jobs')
    await submitCloudJob({ kind: 'image', model: 'z-image-turbo', prompt: 'x', params: { op: 'generate' } }, CREATE_CHAT_ORIGIN)
    await uploadInput(new Blob(['x']), 'source', CREATE_CHAT_ORIGIN)
    await adoptInput('00000000-0000-4000-8000-000000000009', 'image', CREATE_CHAT_ORIGIN)
    expect(writes().map((s) => [s.path, s.origin])).toEqual([
      ['/api/jobs', CREATE_CHAT_ORIGIN], ['/api/jobs/upload', CREATE_CHAT_ORIGIN], ['/api/jobs/adopt', CREATE_CHAT_ORIGIN],
    ])
  })

  it('a result of the chat does not move the Create tab\'s model picker', async () => {
    useCreateStore.setState({ backend: 'cloud', cloudImageModel: 'flux-schnell' } as never)
    const unwatch = watchOrderResults()
    await layOut([{ intent: 'image', prompt: 'a red fox in the snow' }])
    await startOrder(orders()[0].id)
    unwatch()
    expect(useCreateStore.getState().gallery).toHaveLength(1)
    expect(useCreateStore.getState().cloudImageModel).toBe('flux-schnell')
  })
})
