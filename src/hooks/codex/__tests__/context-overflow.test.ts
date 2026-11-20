/**
 * GH #140: under /loop the Code Agent ended pass after pass on HTTP 400 "the
 * request exceeds the available context size" and never compacted. The step
 * now reads the refusal, cuts the history to a budget that fits and goes out
 * again; the budget is remembered for the model and its window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLearnedWindowsForTests,
  capToLearnedWindow,
  contextOverflowOf,
  learnSendWindow,
  MIN_SEND_WINDOW,
  shrunkSendWindow,
} from '../context-overflow'
import { isThinkingUnsupportedError, shouldDowngradeThinking } from '../thinking-downgrade'
import { OpenAIProvider } from '../../../api/providers/openai-provider'

afterEach(() => {
  __resetLearnedWindowsForTests()
  vi.restoreAllMocks()
})

const status400 = (message: string) => Object.assign(new Error(message), { status: 400 })

describe('contextOverflowOf', () => {
  it('reads llama.cpp / the built-in engine, numbers included', () => {
    const e = status400('the request exceeds the available context size, try increasing it (request (34567 tokens), context size (32768 tokens))')
    expect(contextOverflowOf(e)).toEqual({ window: 32768, promptTokens: 34567 })
  })

  it('recognises the sentence without numbers too (a streamed error chunk)', () => {
    expect(contextOverflowOf(new Error('the request exceeds the available context size, try increasing it')))
      .toEqual({ window: undefined, promptTokens: undefined })
  })

  it('reads LM Studio, vLLM / OpenAI and Anthropic wording', () => {
    expect(contextOverflowOf(new Error(
      'Trying to keep the first 17392 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough.',
    ))?.window).toBe(4096)
    expect(contextOverflowOf(new Error(
      "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (39000 in the messages, 1000 in the completion).",
    ))).toEqual({ window: 32768, promptTokens: 40000 })
    expect(contextOverflowOf(new Error('prompt is too long: 210000 tokens > 200000 maximum')))
      .toEqual({ window: 200000, promptTokens: 210000 })
  })

  it('leaves every other failure alone', () => {
    expect(contextOverflowOf(status400('model does not support thinking'))).toBeNull()
    expect(contextOverflowOf(new Error('Failed to fetch'))).toBeNull()
    expect(contextOverflowOf(null)).toBeNull()
    // Asking for a longer window in the chat text is not a refusal.
    expect(contextOverflowOf(new Error('Tool file_read failed: ENOENT'))).toBeNull()
  })
})

describe('shrunkSendWindow', () => {
  it('with both numbers: under the window by the margin', () => {
    const next = shrunkSendWindow(26000, { window: 32768, promptTokens: 34567 }, 30000)!
    // The history scaled by what the server counted, with 15 % room.
    expect(next).toBe(Math.floor(26000 * (32768 / 34567) * 0.85))
    expect(next).toBeLessThan(26000)
  })

  it('with only the window: scaled by our own count', () => {
    expect(shrunkSendWindow(12000, { window: 4096 }, 16000)).toBe(Math.floor(12000 * (4096 / 16000) * 0.75))
  })

  it('with nothing: 40 % off', () => {
    expect(shrunkSendWindow(20000, {}, 24000)).toBe(12000)
  })

  it('always strictly below what was refused', () => {
    // An estimate that ran LOW: the window is above our own count, and the
    // step was refused all the same. It still goes out smaller.
    expect(shrunkSendWindow(10000, { window: 64000 }, 12000)).toBe(7500)
    // And never less than a tenth off, whatever the numbers say.
    expect(shrunkSendWindow(10000, { window: 64000, promptTokens: 60000 }, 12000)).toBe(9000)
  })

  it('gives up where the instructions alone would not fit', () => {
    expect(shrunkSendWindow(MIN_SEND_WINDOW + 10, {}, 5000)).toBeNull()
    expect(shrunkSendWindow(0, {}, 0)).toBeNull()
  })
})

describe('the learned budget', () => {
  it('holds the next step and the next pass under what fit', () => {
    expect(capToLearnedWindow(26000, 'openai::qwen-coder', 32768)).toBe(26000)
    learnSendWindow('openai::qwen-coder', 32768, 20000)
    expect(capToLearnedWindow(26000, 'openai::qwen-coder', 32768)).toBe(20000)
    // Never raises a window that is already smaller.
    expect(capToLearnedWindow(8000, 'openai::qwen-coder', 32768)).toBe(8000)
  })

  it('does not follow the model to a different window', () => {
    learnSendWindow('openai::qwen-coder', 32768, 20000)
    expect(capToLearnedWindow(52000, 'openai::qwen-coder', 65536)).toBe(52000)
    expect(capToLearnedWindow(26000, 'openai::other', 32768)).toBe(26000)
  })
})

describe('a context refusal is not a thinking refusal', () => {
  it('no wasted retry without thinking, no model marked as unable to think', () => {
    const e = status400('the request exceeds the available context size, try increasing it')
    expect(isThinkingUnsupportedError(e)).toBe(false)
    expect(shouldDowngradeThinking(true, e)).toBe(false)
    // Unchanged for a real 400 from a server that does not know the switch.
    expect(shouldDowngradeThinking(true, status400('unknown field: think'))).toBe(true)
  })
})

describe('the provider keeps llama.cpp\'s numbers', () => {
  it('a 400 exceed_context_size_error reaches the agent with both numbers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 400,
        message: 'the request exceeds the available context size, try increasing it',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 34567,
        n_ctx: 32768,
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const provider = new OpenAIProvider({
      id: 'openai', name: 'llama.cpp', enabled: true,
      baseUrl: 'https://llama.test/v1', apiKey: '', isLocal: false,
    })
    const err = await provider.chatWithTools('qwen-coder', [{ role: 'user', content: 'hi' }], []).catch((e) => e)
    expect(contextOverflowOf(err)).toEqual({ window: 32768, promptTokens: 34567 })
  })
})
