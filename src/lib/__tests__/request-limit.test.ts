/**
 * One rule for HTTP 429 in chat, agent, code and voice: the server's sentence
 * word for word, the app's own only as a fallback, and that one claims nothing
 * it cannot know.
 *
 * 09.10.2026: LU Cloud began to answer the limit one model has for all
 * customers together with a finished sentence. The agent replaced it with
 * "The server is limiting how many requests this account may send", which
 * blamed the customer's account for a limit that was not theirs.
 *
 * Run: npx vitest run src/lib/__tests__/request-limit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { requestLimitMessage, requestLimitMessageOf, serverLimitSentence } from '../request-limit'
import { ProviderError } from '../../api/providers/types'

const MODEL_LIMIT = 'Qwen is at its request limit right now. Please send your message again in about 12 seconds, or pick a different model. Nothing was charged.'

describe('a sentence from the server', () => {
  it('is shown word for word', () => {
    expect(requestLimitMessage({ said: MODEL_LIMIT, retryAfterMs: 12_000, nothingCharged: true })).toBe(MODEL_LIMIT)
    expect(requestLimitMessage({ said: 'One free chat request is already running on this account. Wait for it to finish or stop it first.' }))
      .toBe('One free chat request is already running on this account. Wait for it to finish or stop it first.')
    expect(requestLimitMessage({ said: 'Rate limit reached for gpt-x in organization org-1. Please try again in 20s.' }))
      .toBe('Rate limit reached for gpt-x in organization org-1. Please try again in 20s.')
  })

  it('is read from a caught error', () => {
    const err = new ProviderError(MODEL_LIMIT, 'openai', 'rate_limit', 429, undefined, 12_000)
    expect(requestLimitMessageOf(err, { nothingCharged: true })).toBe(MODEL_LIMIT)
  })
})

describe('the status label is not a sentence', () => {
  it.each([
    'too many requests', 'Too Many Requests.', 'HTTP 429', '429 Too Many Requests', 'HTTP 429: Too Many Requests',
    'rate limited', 'Rate limit exceeded', 'request failed (429)', 'Error: too many requests', '', '   ',
  ])('%j', (label) => {
    expect(serverLimitSentence(label)).toBeNull()
  })

  it('and anything that is not text is none either', () => {
    expect(serverLimitSentence(undefined)).toBeNull()
    expect(serverLimitSentence({ message: 'x' })).toBeNull()
  })
})

describe('the fallback', () => {
  it('names the wait the server asked for', () => {
    expect(requestLimitMessage({ said: 'too many requests', retryAfterMs: 42_000 }))
      .toBe('The server is limiting requests right now. Please send your message again in about 42 seconds.')
    expect(requestLimitMessage({ retryAfterMs: 400 }))
      .toBe('The server is limiting requests right now. Please send your message again in about 1 second.')
    expect(requestLimitMessage({ retryAfterMs: 600_000 }))
      .toBe('The server is limiting requests right now. Please send your message again in about 10 minutes.')
  })

  it('names no wait when the server named none', () => {
    for (const retryAfterMs of [undefined, 0, -5, Number.NaN, '12']) {
      expect(requestLimitMessage({ retryAfterMs }))
        .toBe('The server is limiting requests right now. Please wait a moment, then send your message again.')
    }
  })

  it('says whose limit it is in no case, because it does not know', () => {
    for (const facts of [{}, { retryAfterMs: 5000 }, { nothingCharged: true }, { again: 'ask again' }]) {
      expect(requestLimitMessage(facts)).not.toMatch(/account|your plan|you (?:are|have)/i)
    }
  })

  it('says "nothing was charged" only where the app knows it', () => {
    expect(requestLimitMessage({ retryAfterMs: 5000, nothingCharged: true })).toMatch(/ Nothing was charged\.$/)
    expect(requestLimitMessage({ retryAfterMs: 5000 })).not.toContain('charged')
    const foreign = new ProviderError('too many requests', 'openai', 'rate_limit', 429, undefined, 5000)
    expect(requestLimitMessageOf(foreign)).not.toContain('charged')
  })

  it('takes the words for what to do next from the surface', () => {
    expect(requestLimitMessage({ again: 'ask again' }))
      .toBe('The server is limiting requests right now. Please wait a moment, then ask again.')
  })

  it('is left alone when it comes round a second time', () => {
    const once = requestLimitMessage({ retryAfterMs: 5000, nothingCharged: true })
    expect(requestLimitMessage({ said: once })).toBe(once)
  })
})
