/**
 * Bug hunt 01.10.2026 (H5). With no Max Tokens set, the desktop sent LU Cloud
 * its own fallback budget, up to 32768. The server reads any max_tokens as the
 * user's wish, so a free Flash request reserved prompt + 32768 where the web
 * reserves prompt + 8192 for the same message, and fell over to credits while
 * the day's free allowance still had room.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig } from '../types'

async function sentBody(id: 'lu-cloud' | 'openai', maxTokens?: number): Promise<Record<string, unknown>> {
  vi.resetModules()
  const bodies: string[] = []
  const respond = (url: string, init?: { body?: string }) => {
    if (url.includes('/chat/completions')) {
      bodies.push(String(init?.body ?? ''))
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }
    // The catalog knows the window, so the budget math would run.
    return new Response(JSON.stringify({ data: [{ id: 'm', context_length: 131072 }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  vi.doMock('../../backend', () => ({
    isTauri: () => false,
    localFetch: vi.fn(async (url: string, init?: { body?: string }) => respond(url, init)),
    localFetchStream: vi.fn(async (url: string, init?: { body?: string }) => respond(url, init)),
    ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
    backendCall: vi.fn(),
    isPrivateOrLanHost: () => false,
    isDirectFetchAllowed: () => false,
    hostnameOf: (url: string) => new URL(url).hostname,
    ensureProxyAllowsHost: vi.fn(),
  }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => respond(String(url), init)))
  const { OpenAIProvider } = await import('../openai-provider')
  const config: ProviderConfig = { id, name: 'x', enabled: true, apiKey: 'x', baseUrl: 'https://lu-labs.test/api/inference/v1', isLocal: false }
  const provider = new OpenAIProvider(config)
  // The catalog read fills the window table, as the app does on start.
  await provider.listModels()
  for await (const c of provider.chatStream('m', [{ role: 'user', content: 'hi' }], maxTokens ? { maxTokens } : {})) { void c }
  vi.unstubAllGlobals()
  return JSON.parse(bodies[0])
}

describe('the output budget sent to LU Cloud', () => {
  it('is left to the server when the user set none', async () => {
    expect(await sentBody('lu-cloud')).not.toHaveProperty('max_tokens')
  })

  it('is the user own number when they set one', async () => {
    expect((await sentBody('lu-cloud', 4000)).max_tokens).toBe(4000)
  })

  it('another OpenAI-compatible server with a known window still gets the bounded budget', async () => {
    const max = (await sentBody('openai')).max_tokens as number
    expect(max).toBeGreaterThan(0)
    expect(max).toBeLessThanOrEqual(32768)
  })
})
