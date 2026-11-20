/**
 * HTTP 429 at the place where the error is built. Chat, agent and code all
 * show the message of this error, so what it says is what the user reads.
 *
 * Run: npx vitest run src/api/providers/__tests__/a-request-limit-keeps-the-servers-sentence.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig } from '../types'
import { isTerminalModelError } from '../../../lib/http-status'

const backendMock = (respond: () => Response) => ({
  isTauri: () => false,
  localFetch: vi.fn(async () => respond()),
  localFetchStream: vi.fn(async () => respond()),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  backendCall: vi.fn(),
  isPrivateOrLanHost: () => false,
  isDirectFetchAllowed: () => false,
  hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(),
})

const MODEL_LIMIT = 'Qwen is at its request limit right now. Please send your message again in about 12 seconds, or pick a different model. Nothing was charged.'

type Thrown = Error & { code?: string; status?: number; retryAfterMs?: number }

async function refusedBy(kind: 'openai' | 'anthropic', id: ProviderConfig['id'], body: string, headers: Record<string, string> = {}): Promise<Thrown> {
  vi.resetModules()
  const respond = () => new Response(body, { status: 429, headers: { 'content-type': 'application/json', ...headers } })
  vi.doMock('../../backend', () => backendMock(respond))
  vi.stubGlobal('fetch', vi.fn(async () => respond()))
  // No real waiting between the attempts of the short retry ladder.
  vi.doMock('../retry', async (original) => {
    const real = await original<typeof import('../retry')>()
    return { ...real, sendWithTransientRetry: (send: () => Promise<Response>) => send() }
  })
  const config: ProviderConfig = { id, name: 'Some Server', enabled: true, apiKey: 'x', baseUrl: 'https://server.test/v1', isLocal: false }
  const mod = kind === 'openai' ? (await import('../openai-provider')).OpenAIProvider : (await import('../anthropic-provider')).AnthropicProvider
  const provider = new mod(config)
  try {
    for await (const chunk of provider.chatStream('some/model', [{ role: 'user', content: 'go' }])) { void chunk }
  } catch (e) {
    return e as Thrown
  } finally {
    vi.unstubAllGlobals()
    vi.doUnmock('../retry')
    vi.doUnmock('../../backend')
  }
  throw new Error('the request was not refused')
}

describe('the cloud names the limit of one model', () => {
  it('and the sentence arrives word for word, with the wait and as something worth another try', async () => {
    const err = await refusedBy('openai', 'lu-cloud',
      JSON.stringify({ error: MODEL_LIMIT, code: 'model_rate_limited', model: 'qwen', retry_after_seconds: 12 }),
      { 'retry-after': '12' })
    expect(err.message).toBe(MODEL_LIMIT)
    expect(err.code).toBe('rate_limit')
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBe(12_000)
    expect(isTerminalModelError(err)).toBe(false)
  })
})

describe('a server that sends only the label', () => {
  it('the cloud: our sentence, with the wait, and nothing about an account', async () => {
    const err = await refusedBy('openai', 'lu-cloud', JSON.stringify({ error: 'too many requests' }), { 'retry-after': '37' })
    expect(err.message).toBe('The server is limiting requests right now. Please send your message again in about 37 seconds. Nothing was charged.')
    expect(err.message).not.toMatch(/account/i)
  })

  it('a server of the user: no word about what was charged', async () => {
    const err = await refusedBy('openai', 'openai', 'Too Many Requests')
    expect(err.message).toBe('The server is limiting requests right now. Please wait a moment, then send your message again.')
  })
})

describe('the other protocol follows the same rule', () => {
  it('keeps a sentence', async () => {
    const said = 'This request would exceed the rate limit of your organization of 50 requests per minute.'
    const err = await refusedBy('anthropic', 'anthropic', JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: said } }), { 'retry-after': '9' })
    expect(err.message).toBe(said)
    expect(err.code).toBe('rate_limit')
    expect(err.retryAfterMs).toBe(9000)
  })

  it('and falls back without one', async () => {
    const err = await refusedBy('anthropic', 'anthropic', '', { 'retry-after': '9' })
    expect(err.message).toBe('The server is limiting requests right now. Please send your message again in about 9 seconds.')
  })
})
