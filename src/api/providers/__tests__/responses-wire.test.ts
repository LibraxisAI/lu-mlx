/**
 * The Responses API wire (responses-wire.ts): the request LU builds, and the
 * checked parsers for what comes back. The accumulator here is the twin of
 * the Rust one in src-tauri/src/commands/responses.rs; both must turn the
 * same server output into the same events.
 *
 * Run: npx vitest run src/api/providers/__tests__/responses-wire.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  ResponsesWireAccumulator, buildResponsesRequest, parseResponsesErrorBody, parseResponsesJsonResponse,
  parseResponsesWireEvent, parseRustResponsesEvent, responsesUrl, retryAfterFromMessage,
  type RustResponsesEvent,
} from '../responses-wire'

function run(frames: unknown[]): RustResponsesEvent[] {
  const acc = new ResponsesWireAccumulator('sse')
  return frames.flatMap((f) => acc.process(f))
}

describe('buildResponsesRequest', () => {
  it('puts system messages into instructions and the rest into typed input items', () => {
    const req = buildResponsesRequest({
      model: 'gpt-5.5',
      stream: true,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'system', content: 'Answer in English.' },
        { role: 'user', content: 'What is this?', images: [{ data: 'AAAA', mimeType: 'image/png' }] },
        {
          role: 'assistant',
          content: 'Let me read it.',
          tool_calls: [
            { id: 'call_a', function: { name: 'file_read', arguments: { path: 'a.txt' } } },
            { function: { name: 'web_search', arguments: { q: 'x' } } },
          ],
        },
        { role: 'tool', content: 'file body', tool_call_id: 'call_a' },
        { role: 'tool', content: 'search result' },
      ],
    })
    expect(req.instructions).toBe('Be brief.\n\nAnswer in English.')
    expect(req.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me read it.' }] },
      { type: 'function_call', call_id: 'call_a', name: 'file_read', arguments: '{"path":"a.txt"}' },
      { type: 'function_call', call_id: 'call_0', name: 'web_search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'file body' },
      { type: 'function_call_output', call_id: 'call_0', output: 'search result' },
    ])
    expect(req).not.toHaveProperty('messages')
    expect(req.stream).toBe(true)
  })

  it('sends tools flat, as the Responses API names them', () => {
    const req = buildResponsesRequest({
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: {}, required: [] } },
      }],
    })
    expect(req.tools).toEqual([{
      type: 'function',
      name: 'file_read',
      description: 'Read a file',
      parameters: { type: 'object', properties: {}, required: [] },
    }])
    expect(req.tool_choice).toBe('auto')
  })

  it('asks for a reasoning summary only while thinking is on', () => {
    const on = buildResponsesRequest({ model: 'm', stream: true, messages: [], reasoningEffort: 'high' })
    expect(on.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    const off = buildResponsesRequest({ model: 'm', stream: true, messages: [], reasoningEffort: 'none' })
    expect(off.reasoning).toEqual({ effort: 'none' })
    const absent = buildResponsesRequest({ model: 'm', stream: true, messages: [] })
    expect(absent).not.toHaveProperty('reasoning')
  })

  it('maps the budget, the samplers, a schema and store, and extras never override a field', () => {
    const req = buildResponsesRequest({
      model: 'm',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 512,
      jsonSchema: { type: 'object' },
      store: false,
      extra: { top_k: 40, model: 'other', stream: true, min_p: undefined },
    })
    expect(req.temperature).toBe(0.4)
    expect(req.top_p).toBe(0.9)
    expect(req.max_output_tokens).toBe(512)
    expect(req.text).toEqual({ format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: false } })
    expect(req.store).toBe(false)
    expect(req.top_k).toBe(40)
    expect(req.model).toBe('m')
    expect(req.stream).toBe(false)
    expect(req).not.toHaveProperty('min_p')
  })

  it('leaves out a zero budget', () => {
    expect(buildResponsesRequest({ model: 'm', stream: true, messages: [], maxOutputTokens: 0 })).not.toHaveProperty('max_output_tokens')
  })
})

describe('responsesUrl', () => {
  it('appends /responses once', () => {
    expect(responsesUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/responses')
    expect(responsesUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/responses')
    expect(responsesUrl('http://127.0.0.1:8080/v1/responses')).toBe('http://127.0.0.1:8080/v1/responses')
  })
})

describe('parseRustResponsesEvent', () => {
  it('reads every kind the Rust transport sends, with nulls for what is absent', () => {
    expect(parseRustResponsesEvent({ kind: 'text_delta', delta: 'Hi', item_id: null })).toEqual({ kind: 'text_delta', delta: 'Hi', item_id: null })
    expect(parseRustResponsesEvent({
      kind: 'completed', response_id: 'resp_1', model: 'm', status: 'completed', finish_reason: 'stop',
      input_tokens: 10, output_tokens: 3, cached_tokens: null, transport: 'websocket',
    })).toEqual({
      kind: 'completed', response_id: 'resp_1', model: 'm', status: 'completed', finish_reason: 'stop',
      input_tokens: 10, output_tokens: 3, cached_tokens: null, transport: 'websocket',
    })
    expect(parseRustResponsesEvent({ kind: 'error', message: 'nope', retryable: true, status: 429, retry_after_ms: 1500 })).toEqual({
      kind: 'error', status: 429, code: null, message: 'nope', retry_after_ms: 1500, retryable: true, server_raw: null,
    })
    expect(parseRustResponsesEvent({ kind: 'eof' })).toEqual({ kind: 'eof' })
  })

  it('drops what it does not know instead of guessing', () => {
    expect(parseRustResponsesEvent({ kind: 'something_new' })).toBeNull()
    expect(parseRustResponsesEvent('text_delta')).toBeNull()
    expect(parseRustResponsesEvent(null)).toBeNull()
  })
})

describe('ResponsesWireAccumulator', () => {
  it('streams reasoning, text and a tool call, and completes with usage', () => {
    const events = run([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Plan A.' },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 1 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Plan B.' },
      { type: 'response.reasoning_summary_text.done', item_id: 'rs_1', text: 'Plan A.Plan B.' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan A.' }], encrypted_content: 'enc' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hel' },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'lo' },
      { type: 'response.output_text.done', item_id: 'msg_1', text: 'Hello' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '"a.txt"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 2, arguments: '{"path":"a.txt"}' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '{"path":"a.txt"}', status: 'completed' } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1', model: 'gpt-5.5', status: 'completed', output: [],
          usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 4 } },
        },
      },
    ])
    expect(events).toEqual([
      { kind: 'created', response_id: 'resp_1', model: 'gpt-5.5', transport: 'sse' },
      { kind: 'reasoning_delta', delta: 'Plan A.', item_id: 'rs_1', summary: true },
      { kind: 'reasoning_delta', delta: '\n\n', item_id: 'rs_1', summary: true },
      { kind: 'reasoning_delta', delta: 'Plan B.', item_id: 'rs_1', summary: true },
      { kind: 'reasoning_item_done', item_id: 'rs_1', encrypted_content: 'enc', summary: ['Plan A.'] },
      { kind: 'text_delta', delta: 'Hel', item_id: 'msg_1' },
      { kind: 'text_delta', delta: 'lo', item_id: 'msg_1' },
      { kind: 'function_call_started', item_id: 'fc_1', call_id: 'call_1', name: 'file_read' },
      { kind: 'function_call_args_delta', item_id: 'fc_1', call_id: 'call_1', delta: '{"path":' },
      { kind: 'function_call_args_delta', item_id: 'fc_1', call_id: 'call_1', delta: '"a.txt"}' },
      { kind: 'function_call_done', item_id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '{"path":"a.txt"}' },
      {
        kind: 'completed', response_id: 'resp_1', model: 'gpt-5.5', status: 'completed', finish_reason: 'tool_calls',
        input_tokens: 12, output_tokens: 7, cached_tokens: 4, transport: 'sse',
      },
    ])
  })

  it('shows a text that arrives only in the done events exactly once', () => {
    const texts = run([
      { type: 'response.output_text.done', item_id: 'msg_1', text: 'Only here' },
      { type: 'response.content_part.done', item_id: 'msg_1', part: { type: 'output_text', text: 'Only here' } },
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Only here' }] } },
      { type: 'response.completed', response: { id: 'r', status: 'completed', output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Only here' }] }] } },
    ]).filter((e) => e.kind === 'text_delta')
    expect(texts).toEqual([{ kind: 'text_delta', delta: 'Only here', item_id: 'msg_1' }])
  })

  it('takes a bare response object (a server that ignored stream: true)', () => {
    const events = run([{
      object: 'response', id: 'resp_9', model: 'm', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', id: 'msg', content: [{ type: 'output_text', text: 'Cut' }] }],
    }])
    expect(events).toEqual([
      { kind: 'text_delta', delta: 'Cut', item_id: 'msg' },
      {
        kind: 'completed', response_id: 'resp_9', model: 'm', status: 'incomplete', finish_reason: 'length',
        input_tokens: null, output_tokens: null, cached_tokens: null, transport: 'sse',
      },
    ])
  })

  it('names a content filter cut as such', () => {
    const events = run([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } }])
    expect(events[events.length - 1]).toMatchObject({ kind: 'completed', finish_reason: 'content_filter' })
  })

  it('reads the error frame of a WebSocket and a failed response as errors, and stops there', () => {
    const acc = new ResponsesWireAccumulator('websocket')
    expect(acc.process({ type: 'error', status: 429, error: { type: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.' } })).toEqual([{
      kind: 'error', status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.',
      retry_after_ms: 1500, retryable: true, server_raw: null,
    }])
    expect(acc.process({ type: 'response.output_text.delta', delta: 'late' })).toEqual([])

    const failed = run([{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'Upstream died' }, output: [] } }])
    expect(failed).toEqual([{
      kind: 'error', status: null, code: 'server_error', message: 'Upstream died', retry_after_ms: null, retryable: true, server_raw: null,
    }])
  })

  it('finishes a call whose arguments came only on the done event', () => {
    const events = run([
      { type: 'response.function_call_arguments.done', item_id: 'fc_2', name: 'shell_execute', arguments: '{"cmd":"ls"}' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ])
    expect(events).toEqual([
      { kind: 'function_call_started', item_id: 'fc_2', call_id: 'fc_2', name: 'shell_execute' },
      { kind: 'function_call_done', item_id: 'fc_2', call_id: 'fc_2', name: 'shell_execute', arguments: '{"cmd":"ls"}' },
      {
        kind: 'completed', response_id: null, model: null, status: 'completed', finish_reason: 'tool_calls',
        input_tokens: null, output_tokens: null, cached_tokens: null, transport: 'sse',
      },
    ])
  })

  it('closes an answer at [DONE] without a terminal event, and says nothing for an empty one', () => {
    const acc = new ResponsesWireAccumulator('sse')
    acc.process({ type: 'response.output_text.delta', delta: 'Hi' })
    expect(acc.finishWithoutTerminal()).toMatchObject([{ kind: 'completed', finish_reason: 'stop' }])
    expect(new ResponsesWireAccumulator('sse').finishWithoutTerminal()).toEqual([])
  })
})

describe('parsers at the edge', () => {
  it('ignores what is not a Responses event', () => {
    expect(parseResponsesWireEvent('x')).toEqual({ type: 'ignored' })
    expect(parseResponsesWireEvent({ type: 'response.audio.delta' })).toEqual({ type: 'ignored' })
    expect(parseResponsesJsonResponse({ choices: [] })).toBeNull()
  })

  it('uses the SSE event name when the payload has no type', () => {
    expect(parseResponsesWireEvent({ delta: 'x', item_id: 'm' }, 'response.output_text.delta')).toEqual({ type: 'text_delta', itemId: 'm', delta: 'x' })
  })

  it('turns an HTTP error body into an error event', () => {
    expect(parseResponsesErrorBody(400, '{"error":{"message":"Unsupported parameter: reasoning","code":"unsupported_parameter"}}')).toMatchObject({
      kind: 'error', status: 400, code: 'unsupported_parameter', message: 'Unsupported parameter: reasoning', retryable: false,
    })
    expect(parseResponsesErrorBody(503, 'Service Unavailable', 2000)).toMatchObject({
      status: 503, message: 'HTTP 503: Service Unavailable', retry_after_ms: 2000, retryable: true,
    })
    expect(parseResponsesErrorBody(500, '')).toMatchObject({ message: 'HTTP 500', server_raw: null })
  })

  it('reads the wait OpenAI writes into a rate limit message', () => {
    expect(retryAfterFromMessage('Please try again in 20ms.')).toBe(20)
    expect(retryAfterFromMessage('Please try again in 1.5s.')).toBe(1500)
    expect(retryAfterFromMessage('Slow down.')).toBeUndefined()
  })
})
