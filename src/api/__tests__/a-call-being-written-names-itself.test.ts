/**
 * Realtime pass 01.10.2026 (R1). A model that answers with a tool call streams
 * the call's arguments for seconds: a 4 kB file_write on Mistral Small took
 * ~11 s from the first argument byte to the end (measured live against
 * the upstream). The providers kept the pieces to themselves until the done
 * chunk, and the run showed "Working" with an "Analyzing..." placeholder the
 * whole time. They now report the call while it is being written.
 *
 * Run: npx vitest run src/api/__tests__/a-call-being-written-names-itself.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIProvider } from '../providers/openai-provider'
import { AnthropicProvider } from '../providers/anthropic-provider'
import type { ChatStreamChunk, ToolCallProgress } from '../providers/types'
import { streamProviderTurn } from '../../lib/provider-stream'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

const openaiSse = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"file_write","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.html\\","}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"hi\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
  '',
].join('\n\n')

function openai(): OpenAIProvider {
  return new OpenAIProvider({ id: 'openai', name: 'T', enabled: true, baseUrl: 'https://api.test.com/v1', apiKey: 'k', isLocal: false })
}

describe('a tool call names itself while it is written', () => {
  it('OpenAI-compatible stream: progress with the name and the growing size, before the done chunk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(openaiSse, { status: 200 }))
    const chunks = await drain(openai().chatStream('m', [{ role: 'user', content: 'x' }]))
    const done = chunks.findIndex((c) => c.done)
    const progress = chunks.slice(0, done).flatMap((c) => (c.toolProgress ? [c.toolProgress] : []))
    expect(progress.map((p) => p.name)).toEqual(['file_write', 'file_write', 'file_write'])
    expect(progress.map((p) => p.argsChars)).toEqual([0, 17, 32])
    // The finished call still arrives once, on the done chunk.
    expect(chunks[done].toolCalls?.[0].function.name).toBe('file_write')
  })

  it('Anthropic stream: progress from the block start and every JSON piece', async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"file_write"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(events.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))
    const chunks = await drain(new AnthropicProvider({ id: 'anthropic', name: 'A', enabled: true, baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', isLocal: false })
      .chatStream('claude-sonnet-4-20250514', [{ role: 'user', content: 'x' }]))
    const progress = chunks.flatMap((c) => (c.toolProgress ? [c.toolProgress] : []))
    expect(progress).toEqual([
      { name: 'file_write', argsChars: 0 },
      { name: 'file_write', argsChars: 8 },
      { name: 'file_write', argsChars: 12 },
    ])
  })

  it('streamProviderTurn hands the progress to the run, and the turn result is unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(openaiSse, { status: 200 }))
    const seen: ToolCallProgress[] = []
    const turn = await streamProviderTurn(openai(), 'm', [{ role: 'user', content: 'x' }], {}, undefined, undefined, (p) => seen.push(p))
    expect(seen.at(-1)).toEqual({ name: 'file_write', argsChars: 32 })
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].function.arguments).toEqual({ path: 'a.html', content: 'hi' })
    expect(turn.content).toBe('')
  })
})
