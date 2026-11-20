/**
 * The two windows of an Ollama model as numbers (lib/context-window.ts).
 * These are the numbers the turn hooks sent before there was one source;
 * `ollamaWindowFor` must not have moved any of them.
 */
import { describe, it, expect } from 'vitest'
import { AGENT_CONTEXT_CAP, AGENT_CONTEXT_FLOOR, DEFAULT_CONTEXT_CAP, effectiveContextWindow, ollamaWindowFor } from '../context-window'

describe('ollamaWindowFor', () => {
  it.each([4096, 8192, 16384, 32768, 131072, 262144, 0, undefined])('chat on a model trained on %s is what the chat always sent', (max) => {
    expect(ollamaWindowFor('chat', max)).toBe(effectiveContextWindow(max, 0))
  })

  it.each([4096, 8192, 16384, 32768, 131072, 262144, 0, undefined])('agent on a model trained on %s is what the agent always sent', (max) => {
    expect(ollamaWindowFor('agent', max)).toBe(Math.max(effectiveContextWindow(max, 0, AGENT_CONTEXT_CAP), 8192))
  })

  it('the two differ only where the model can take more than the chat cap', () => {
    expect(ollamaWindowFor('chat', 131072)).toBe(DEFAULT_CONTEXT_CAP)
    expect(ollamaWindowFor('agent', 131072)).toBe(AGENT_CONTEXT_CAP)
    expect(ollamaWindowFor('chat', 16384)).toBe(ollamaWindowFor('agent', 16384))
    expect(ollamaWindowFor('chat', 8192)).toBe(ollamaWindowFor('agent', 8192))
  })

  it('an agent turn never runs below its floor, a chat turn never above its model', () => {
    expect(ollamaWindowFor('agent', 4096)).toBe(AGENT_CONTEXT_FLOOR)
    expect(ollamaWindowFor('chat', 4096)).toBe(4096)
  })

  it("the user's own setting is both windows", () => {
    expect(ollamaWindowFor('chat', 131072, 65536)).toBe(65536)
    expect(ollamaWindowFor('agent', 131072, 65536)).toBe(65536)
    expect(ollamaWindowFor('agent', 4096, 2048)).toBe(2048)
  })
})
