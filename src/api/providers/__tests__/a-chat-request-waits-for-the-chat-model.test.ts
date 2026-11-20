/**
 * A Create render moves the local chat model off the graphics card and, since
 * 3.0.5, leaves it out until it is needed (api/vram-handoff). The need is a
 * chat request: the local providers wait for the parked restore before they
 * send, so nobody chats into an unloaded LM Studio or a stopped engine. A
 * hosted endpoint has no model on this machine and waits for nothing.
 *
 * Run: npx vitest run src/api/providers/__tests__/a-chat-request-waits-for-the-chat-model.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, ChatStreamChunk } from '../types'

const order: string[] = []
const streamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
const ollamaBody = '{"message":{"role":"assistant","content":"hi"},"done":true}\n'

async function load() {
  vi.resetModules()
  const respond = async (url: string, init?: { body?: string }) => {
    // Only the chat request itself counts; a local provider may read the
    // model's context window first, which loads nothing.
    if (/\/chat\/completions|\/api\/chat/.test(String(url))) order.push('request')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { stream?: boolean } : {}
    if (String(url).includes('/api/chat')) {
      return new Response(body.stream ? ollamaBody : JSON.stringify({ message: { role: 'assistant', content: 'ok' } }), { status: 200 })
    }
    if (body.stream) return new Response(streamBody, { status: 200 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }
  vi.doMock('../../backend', () => ({
    localFetch: vi.fn(respond),
    localFetchStream: vi.fn(respond),
    backendCall: vi.fn(),
    ollamaUrl: (path: string) => `/api${path}`,
    isPrivateOrLanHost: (host: string) => host === 'localhost' || host === '127.0.0.1',
    isDirectFetchAllowed: () => true,
    hostnameOf: (url: string) => new URL(url).hostname,
    ensureProxyAllowsHost: vi.fn(),
    isTauri: () => false,
  }))
  vi.doMock('../../builtin-ensure', () => ({
    ensureBuiltinEngineAlive: vi.fn(),
    explainDeadEngine: (e: unknown) => e,
    explainEngineTransportMessage: (m: string) => m,
    isManagedBuiltinSlot: () => false,
  }))
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => respond(String(url), { body: typeof init?.body === 'string' ? init.body : undefined }))
  const gate = await import('../../../lib/chat-backends-gate')
  const { OpenAIProvider } = await import('../openai-provider')
  const { OllamaProvider } = await import('../ollama-provider')
  return { gate, OpenAIProvider, OllamaProvider }
}

const LM_STUDIO: ProviderConfig = { id: 'openai', name: 'LM Studio', apiKey: '', enabled: true, baseUrl: 'http://127.0.0.1:1234/v1', isLocal: true }
const HOSTED: ProviderConfig = { id: 'openai', name: 'Hosted', apiKey: 'k', enabled: true, baseUrl: 'https://api.example.com/v1', isLocal: false }
const OLLAMA: ProviderConfig = { id: 'ollama', name: 'Ollama', apiKey: '', enabled: true, baseUrl: 'http://localhost:11434', isLocal: true }
const USER = [{ role: 'user' as const, content: 'hi' }]

async function drain(gen: AsyncGenerator<ChatStreamChunk>) {
  for await (const _ of gen) { /* the request fires on the first next() */ }
}
/** A restore that takes a moment, like a model load. */
const parkedRestore = () => vi.fn(async () => {
  order.push('restore started')
  await new Promise((r) => setTimeout(r, 20))
  order.push('restore done')
})

beforeEach(() => { order.length = 0 })
afterEach(() => {
  vi.doUnmock('../../backend')
  vi.doUnmock('../../builtin-ensure')
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('a chat request while a render has the chat model parked', () => {
  it('LM Studio and the built-in engine (OpenAI compatible, local): the stream waits for the restore', async () => {
    const { gate, OpenAIProvider } = await load()
    const restore = parkedRestore()
    gate.setChatBackendsRestore(restore)
    await drain(new OpenAIProvider(LM_STUDIO).chatStream('m', USER))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(order.slice(0, 3)).toEqual(['restore started', 'restore done', 'request'])
  })

  it('the same for a tool turn', async () => {
    const { gate, OpenAIProvider } = await load()
    gate.setChatBackendsRestore(parkedRestore())
    await new OpenAIProvider(LM_STUDIO).chatWithTools('m', USER, [])
    expect(order.slice(0, 3)).toEqual(['restore started', 'restore done', 'request'])
  })

  it('Ollama: stream and tool turn wait for the restore', async () => {
    const { gate, OllamaProvider } = await load()
    const restore = parkedRestore()
    gate.setChatBackendsRestore(restore)
    await drain(new OllamaProvider(OLLAMA).chatStream('qwen:14b', USER))
    expect(order.slice(0, 3)).toEqual(['restore started', 'restore done', 'request'])
    order.length = 0
    await new OllamaProvider(OLLAMA).chatWithTools('qwen:14b', USER, [])
    expect(order.slice(0, 3)).toEqual(['restore started', 'restore done', 'request'])
  })

  it('a hosted endpoint has no model on this machine: it sends at once', async () => {
    const { gate, OpenAIProvider } = await load()
    const restore = parkedRestore()
    gate.setChatBackendsRestore(restore)
    await drain(new OpenAIProvider(HOSTED).chatStream('m', USER))
    expect(restore).not.toHaveBeenCalled()
    expect(order).toContain('request')
  })

  it('nothing parked: nothing to wait for', async () => {
    const { gate, OpenAIProvider } = await load()
    gate.setChatBackendsRestore(null)
    await drain(new OpenAIProvider(LM_STUDIO).chatStream('m', USER))
    expect(order[0]).toBe('request')
  })

  it('a restore that fails does not stop the message', async () => {
    const { gate, OpenAIProvider } = await load()
    gate.setChatBackendsRestore(async () => { throw new Error('LM Studio is not running') })
    await drain(new OpenAIProvider(LM_STUDIO).chatStream('m', USER))
    expect(order).toContain('request')
  })
})
