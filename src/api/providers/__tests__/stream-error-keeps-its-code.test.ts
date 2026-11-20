/**
 * LU Cloud ends a step it will not let run on with an SSE error chunk
 * (lu-labs.ai inference route, 30.09.2026): `stalled_dead` after 90 s without
 * a byte, `stalled_runaway` after 10 minutes without visible output. The
 * provider used to throw a bare Error, the code was lost, and the agent's
 * retry ladder read "no status" as transient and sent the runaway step again,
 * twice, ten minutes each, on the customer's credits.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig } from '../types'
import { isTerminalModelError } from '../../../lib/http-status'

type CapturedInit = { method?: string; headers?: Record<string, string>; body?: string }

const backendMock = (respond: (url: string) => Response) => ({
  isTauri: () => false,
  localFetch: vi.fn(async (url: string, _init: CapturedInit) => respond(url)),
  localFetchStream: vi.fn(async (url: string, _init: CapturedInit) => respond(url)),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  backendCall: vi.fn(),
  isPrivateOrLanHost: () => false,
  isDirectFetchAllowed: () => false,
  hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(),
})

async function streamError(code: string): Promise<unknown> {
  vi.resetModules()
  const body =
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Writing the page.' } }] })}\n\n` +
    `data: ${JSON.stringify({ error: { message: `ended (${code})`, type: 'stalled', code } })}\n\n` +
    'data: [DONE]\n\n'
  vi.doMock('../../backend', () =>
    backendMock((url) =>
      url.includes('/chat/completions')
        ? new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        : new Response('{}', { status: 404 }),
    ),
  )
  const { OpenAIProvider } = await import('../openai-provider')
  const config: ProviderConfig = {
    id: 'openai', name: 'LU Cloud', enabled: true, apiKey: 'x', baseUrl: 'https://lu-labs.test/api/inference/v1', isLocal: false,
  }
  const p = new OpenAIProvider(config)
  try {
    for await (const chunk of p.chatStream('google/gemma-4-26B-A4B-it', [{ role: 'user', content: 'go' }])) { void chunk }
  } catch (e) {
    return e
  }
  throw new Error('the stream did not throw')
}

describe('a stream error chunk keeps its code', () => {
  it('a runaway step is thrown with its code and is not retried', async () => {
    const err = await streamError('stalled_runaway')
    expect((err as { code?: string }).code).toBe('stalled_runaway')
    expect((err as Error).message).toContain('ended (stalled_runaway)')
    expect(isTerminalModelError(err)).toBe(true)
  })

  it('a dead line keeps its code and stays retryable', async () => {
    const err = await streamError('stalled_dead')
    expect((err as { code?: string }).code).toBe('stalled_dead')
    expect(isTerminalModelError(err)).toBe(false)
  })
})

describe('a request without streaming that LU Cloud ended as a runaway', () => {
  it('is sent once, thrown with its code, and terminal', async () => {
    vi.resetModules()
    const calls: string[] = []
    vi.doMock('../../backend', () =>
      backendMock((url) => {
        if (!url.includes('/chat/completions')) return new Response('{}', { status: 404 })
        calls.push(url)
        return new Response(
          JSON.stringify({ error: 'The model produced no visible output for 10 minutes, so this step was ended.', code: 'stalled_runaway' }),
          // 422: the server answers a runaway with a 4xx so no app version retries it.
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        )
      }),
    )
    const { OpenAIProvider } = await import('../openai-provider')
    const p = new OpenAIProvider({
      id: 'openai', name: 'LU Cloud', enabled: true, apiKey: 'x', baseUrl: 'https://lu-labs.test/api/inference/v1', isLocal: false,
    })
    const err = await p.chatWithTools('google/gemma-4-26B-A4B-it', [{ role: 'user', content: 'go' }], []).then(
      () => { throw new Error('did not throw') },
      (e: unknown) => e,
    )
    expect(calls).toHaveLength(1)
    expect((err as { code?: string }).code).toBe('stalled_runaway')
    expect(isTerminalModelError(err)).toBe(true)
  })
})
