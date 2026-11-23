/**
 * The OpenAI-compatible provider on the Responses API (`apiProtocol:
 * 'responses'`), through the browser path of responses-client.ts against a
 * stubbed network: what the request looks like, how the events become chat
 * chunks, how a tool turn is collected, and that every failure reaches the
 * chat as an English sentence without a Rust command name in it.
 *
 * The desktop path (Rust, WebSocket first) has its own tests in
 * src-tauri/src/commands/responses.rs; both end in the same event vocabulary.
 *
 * Run: npx vitest run src/api/providers/__tests__/responses-provider.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import { ProviderError, type ChatStreamChunk, type ProviderConfig } from '../types'
import { mapResponsesError, type ResponsesErrorContext } from '../responses-client'
import { cachedClient, clearProviderCache } from '../client-cache'
import { getProvider } from '../registry'
import { useProviderStore, sanitizeOpenAIEntries } from '../../../stores/providerStore'
import { remoteBackendUnreachableMessage } from '../../../lib/local-backend-transport'

const BASE = 'https://api.test.com/v1'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'TestProvider',
    enabled: true,
    baseUrl: BASE,
    apiKey: 'test-key',
    isLocal: false,
    apiProtocol: 'responses',
    ...overrides,
  }
}

function sse(frames: Record<string, unknown>[], headers: Record<string, string> = {}): Response {
  const body = frames.map((f) => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } })
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

interface Seen {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

/** Every POST to /responses, answered in order by `answers` (the last one repeats). */
function stubResponses(...answers: Array<() => Response | Promise<Response>>): Seen[] {
  const seen: Seen[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith('/responses')) return new Response('{}', { status: 404 })
    seen.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : {},
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    })
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)]
    return answer()
  })
  return seen
}

async function collect(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

const COMPLETED = {
  type: 'response.completed',
  response: {
    id: 'resp_1', model: 'gpt-5.5', status: 'completed', output: [],
    usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 4 } },
  },
}

afterEach(() => {
  vi.restoreAllMocks()
  clearProviderCache()
})

describe('chatStream on the Responses API', () => {
  it('sends a Responses request and streams thinking, text and a repaired tool call', async () => {
    const seen = stubResponses(() => sse([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Thinking' },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hel' },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'lo' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '"a.txt"' },
      // The model never closed its object; the repair closes it.
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '{"path":"a.txt"', status: 'completed' } },
      COMPLETED,
    ]))
    const provider = new OpenAIProvider(makeConfig())
    const chunks = await collect(provider.chatStream('gpt-5.5', [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ]))

    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`${BASE}/responses`)
    expect(seen[0].headers.Authorization).toBe('Bearer test-key')
    expect(seen[0].body.instructions).toBe('Be brief.')
    expect(seen[0].body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
    expect(seen[0].body.store).toBe(false)
    expect(seen[0].body.stream).toBe(true)
    expect(seen[0].body).not.toHaveProperty('messages')
    expect(seen[0].body).not.toHaveProperty('stream_options')

    expect(chunks.filter((c) => c.thinking).map((c) => c.thinking)).toEqual(['Thinking'])
    expect(chunks.filter((c) => c.content).map((c) => c.content)).toEqual(['Hel', 'lo'])
    expect(chunks.filter((c) => c.toolProgress).map((c) => c.toolProgress)).toEqual([
      { name: 'file_read', argsChars: 0 },
      { name: 'file_read', argsChars: 8 },
      { name: 'file_read', argsChars: 15 },
    ])
    const done = chunks[chunks.length - 1]
    expect(done).toMatchObject({
      done: true,
      finishReason: 'tool_calls',
      promptEvalCount: 12,
      evalCount: 7,
      cachedPromptCount: 4,
    })
    expect(done.toolCalls).toEqual([{ id: 'call_1', function: { name: 'file_read', arguments: { path: 'a.txt' } } }])
  })

  it('keeps the Chat Completions wire when the protocol is not set', async () => {
    const urls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input))
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    await collect(new OpenAIProvider(makeConfig({ apiProtocol: undefined })).chatStream('m', [{ role: 'user', content: 'hi' }]))
    expect(urls.some((u) => u.endsWith('/chat/completions'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/responses'))).toBe(false)
  })

  it('sends a turn once more without reasoning when the endpoint refuses the field', async () => {
    const seen = stubResponses(
      () => json(400, { error: { message: 'Unsupported parameter: reasoning.effort', code: 'unsupported_parameter' } }),
      () => sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'Fine' }, COMPLETED]),
    )
    const chunks = await collect(new OpenAIProvider(makeConfig()).chatStream('gpt-4.1', [{ role: 'user', content: 'hi' }], { thinking: true }))
    expect(seen).toHaveLength(2)
    expect(seen[0].body.reasoning).toMatchObject({ effort: expect.any(String) })
    expect(seen[1].body).not.toHaveProperty('reasoning')
    expect(chunks.map((c) => c.content).join('')).toBe('Fine')
  })

  it('ends a stream that broke off after the answer began as a disconnect', async () => {
    stubResponses(() => sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'partial' }]))
    const chunks = await collect(new OpenAIProvider(makeConfig()).chatStream('m', [{ role: 'user', content: 'hi' }]))
    expect(chunks.map((c) => c.content).join('')).toBe('partial')
    expect(chunks[chunks.length - 1]).toMatchObject({ done: true, finishReason: 'disconnect' })
  })

  it('throws an AbortError and sends nothing when Stop came first', async () => {
    const seen = stubResponses(() => sse([COMPLETED]))
    const ctl = new AbortController()
    ctl.abort()
    await expect(collect(new OpenAIProvider(makeConfig()).chatStream('m', [{ role: 'user', content: 'hi' }], { signal: ctl.signal })))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toHaveLength(0)
  })
})

describe('chatWithTools on the Responses API', () => {
  it('collects text and calls, sends tools flat and the schema as text.format', async () => {
    const seen = stubResponses(() => sse([
      { type: 'response.output_text.delta', item_id: 'm', delta: 'Reading.' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'file_read', arguments: '{"path":"b.txt"}', status: 'completed' } },
      COMPLETED,
    ]))
    const result = await new OpenAIProvider(makeConfig()).chatWithTools(
      'gpt-5.5',
      [{ role: 'user', content: 'read b' }],
      [{ type: 'function', function: { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      { jsonSchema: { type: 'object' } },
    )
    expect(seen[0].body.tools).toEqual([{
      type: 'function',
      name: 'file_read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }])
    expect(seen[0].body.tool_choice).toBe('auto')
    expect(seen[0].body.text).toEqual({ format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: false } })
    expect(result.content).toBe('Reading.')
    expect(result.toolCalls).toEqual([{ id: 'call_9', function: { name: 'file_read', arguments: { path: 'b.txt' } } }])
    expect(result.promptEvalCount).toBe(12)
    expect(result.cachedPromptCount).toBe(4)
  })

  it('sends the history of a tool run as function_call and function_call_output items', async () => {
    const seen = stubResponses(() => sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'Done.' }, COMPLETED]))
    await new OpenAIProvider(makeConfig()).chatWithTools('gpt-5.5', [
      { role: 'user', content: 'read a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', function: { name: 'file_read', arguments: { path: 'a.txt' } } }] },
      { role: 'tool', content: 'file body', tool_call_id: 'call_a' },
    ], [{ type: 'function', function: { name: 'file_read', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } } }])
    expect(seen[0].body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a' }] },
      { type: 'function_call', call_id: 'call_a', name: 'file_read', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'file body' },
    ])
  })
})

describe('Responses errors in the chat', () => {
  async function failure(answer: () => Response | Promise<Response>): Promise<ProviderError> {
    stubResponses(answer)
    try {
      await collect(new OpenAIProvider(makeConfig()).chatStream('m', [{ role: 'user', content: 'hi' }]))
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      return err as ProviderError
    }
    throw new Error('the turn did not fail')
  }

  it('keeps the server sentence of a rate limit and its wait', async () => {
    const err = await failure(() => json(429, { error: { message: 'Rate limit reached for gpt-5.5.', type: 'rate_limit_exceeded' } }, { 'retry-after': '2' }))
    expect(err.code).toBe('rate_limit')
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBe(2000)
    expect(err.message).toContain('Rate limit reached')
  })

  it('names a refused key as such', async () => {
    const err = await failure(() => json(401, { error: { message: 'Incorrect API key provided.' } }))
    expect(err.code).toBe('auth')
    expect(err.message).toBe('Incorrect API key provided.')
  })

  it('turns an unreachable endpoint into the plain sentence, never the raw line', async () => {
    const err = await failure(() => { throw new TypeError('Failed to fetch') })
    expect(err.code).toBe('network')
    expect(err.message).toBe(remoteBackendUnreachableMessage('TestProvider', BASE))
    expect(err.message).not.toMatch(/proxy_localhost|responses_stream|error sending request/)
  })

  it('strips Rust command names from whatever is left', () => {
    const ctx: ResponsesErrorContext = {
      providerName: 'TestProvider', baseUrl: BASE, managed: false, lan: false, viaProxy: true, luCloud: false, toolsSent: false,
    }
    const err = mapResponsesError({
      kind: 'error', status: 502, code: null, message: 'responses_stream: proxy_localhost_stream_chunked: upstream said no',
      retry_after_ms: null, retryable: true, server_raw: null,
    }, ctx)
    expect(err.message).toBe('upstream said no')
    const ipc = mapResponsesError({ kind: 'error', status: null, code: 'ipc', message: 'ipc', retry_after_ms: null, retryable: false, server_raw: null }, ctx)
    expect(ipc.message).not.toMatch(/responses_|ipc/)
    expect(ipc.code).toBe('network')
  })
})

describe('protocol settings', () => {
  it('a protocol or transport change builds a new client', () => {
    const create = vi.fn((config: ProviderConfig) => new OpenAIProvider(config))
    const cfg = (o: Partial<ProviderConfig>) => makeConfig({ apiProtocol: undefined, ...o })
    const chat = cachedClient(cfg({}), () => create(cfg({})))
    const responses = cachedClient(cfg({ apiProtocol: 'responses' }), () => create(cfg({ apiProtocol: 'responses' })))
    const sseOnly = cachedClient(cfg({ apiProtocol: 'responses', responsesTransport: 'sse' }), () => create(cfg({ apiProtocol: 'responses', responsesTransport: 'sse' })))
    expect(responses).not.toBe(chat)
    expect(sseOnly).not.toBe(responses)
    expect(cachedClient(cfg({ apiProtocol: 'responses' }), () => create(cfg({ apiProtocol: 'responses' })))).toBe(responses)
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('an entry keeps a known protocol and transport out of storage and drops anything else', () => {
    const [kept, dropped] = sanitizeOpenAIEntries([
      { entryId: 'lab-box', name: 'Lab', enabled: true, baseUrl: 'http://10.0.0.5:8000/v1', apiKey: '', isLocal: true, apiProtocol: 'responses', responsesTransport: 'websocket' },
      { entryId: 'other-box', name: 'Other', enabled: true, baseUrl: 'http://10.0.0.6:8000/v1', apiKey: '', isLocal: true, apiProtocol: 'grpc', responsesTransport: 'pigeon' },
    ])
    expect(kept.apiProtocol).toBe('responses')
    expect(kept.responsesTransport).toBe('websocket')
    expect(dropped).not.toHaveProperty('apiProtocol')
    expect(dropped).not.toHaveProperty('responsesTransport')
  })

  it('an extra slot stores the protocol and its client speaks it', async () => {
    const store = useProviderStore.getState()
    const id = store.addCompatProvider({ slug: 'responses-test', name: 'Responses Test', baseUrl: BASE })
    expect(id).toBe('openai-responses-test')
    if (!id) return
    store.setProviderConfig(id, { apiProtocol: 'responses', responsesTransport: 'sse' })
    store.setProviderConfig(id, { apiProtocol: 'bogus' as unknown as 'responses' })
    expect(useProviderStore.getState().providers[id]).toMatchObject({ apiProtocol: 'responses', responsesTransport: 'sse' })

    const seen = stubResponses(() => sse([{ type: 'response.output_text.delta', item_id: 'm', delta: 'ok' }, COMPLETED]))
    const chunks = await collect(getProvider(id).chatStream('m', [{ role: 'user', content: 'hi' }]))
    expect(seen[0]?.url).toBe(`${BASE}/responses`)
    expect(chunks.map((c) => c.content).join('')).toBe('ok')
    useProviderStore.getState().removeCompatProvider(id)
  })
})
