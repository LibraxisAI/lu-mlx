/**
 * @vitest-environment jsdom
 *
 * Nachbesserung 6 (review-lanes.md, Runde 3): the review's point 8 named
 * this as the single most important missing test in the whole round:
 * "kein einziger Test darauf, dass der Wiedereintritts-Riegel auf
 * DERSELBEN Unterhaltung noch blockt". The re-entry guard
 * (`activeAgentRuns.has(convId)` in useAgentChat.ts) protects against a
 * real, priced incident: one prompt sent twice (two Enters before React
 * repaints Send into Stop) ran `video_generate` four times
 * (gemma4:e4b + SVD-XT, 2026-06-16). The B2 refactor changed the
 * guard's key from a hook-instance ref to a per-conversation Map; this
 * test is the proof that the thing the key protects against is still
 * caught after that change, not just that a DIFFERENT conversation is no
 * longer wrongly blocked (the review's other, already-covered concern).
 *
 * Run: npx vitest run src/hooks/__tests__/agentenlauf-doppelklick-auf-derselben-unterhaltung.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../api/cloud/supabase', () => ({
  getAccessToken: async () => 'session-token-abc',
}))
vi.mock('../../api/rag', () => ({
  retrieveContext: async () => ({ context: { chunks: [], query: '', documentIds: [] }, scoredChunks: [] }),
  generateEmbeddings: async () => [[0.1, 0.2]],
}))
vi.mock('../../lib/ttsBridge', () => ({ autoSpeak: () => {} }))
vi.mock('../../api/vram-handoff', () => ({ requestGenerationCancel: () => {} }))
vi.mock('../useMemory', () => ({
  useMemory: () => ({ extractAndSave: async () => {} }),
  extractMemoriesFromPair: async () => {},
}))

import { useAgentChat } from '../useAgentChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useAgentTaskStore } from '../../stores/agentTaskStore'
import { useAgentLoopStore } from '../../stores/agentLoopStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useTodoStore } from '../../stores/todoStore'
import { useToolAuditStore } from '../../stores/toolAuditStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { __resetRunStopsForTests } from '../../lib/run-stop'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

const sse = (payload: object) =>
  new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
// A single completed turn, no tool call: enough to prove call COUNT, which
// is what a duplicate send is about. Voice-driving an actual video_generate
// through ComfyUI is covered by the vram-handoff suite; a second real model
// call is the one thing that has to not happen here.
const textZug = () => sse({ choices: [{ delta: { content: 'a video of a cat' } }] })

function seed(): string {
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  return convId
}

beforeEach(() => {
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentModeStore.setState({ agentModeActive: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useToolAuditStore.setState({ entries: {} })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' },
  })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
  useModelStore.setState({ models: [], activeModel: MODEL })
})
afterEach(() => vi.restoreAllMocks())

describe('der Wiedereintritts-Riegel blockt einen Doppelklick auf DERSELBEN Unterhaltung', () => {
  it('ein Prompt, zweimal in derselben Zehntelsekunde gesendet: genau EINE Modellanfrage', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      calls++
      return textZug()
    })

    const { result } = renderHook(() => useAgentChat())
    seed()

    let run1!: Promise<void>
    let run2!: Promise<void>
    await act(async () => {
      // No await between the two calls, on purpose: this IS the
      // double-submit shape (two Enters before React repaints Send into
      // Stop), and useAgentChat-zwei-agentenlaeufe-vermischen-nicht.test.ts
      // already proves the guard is claimed synchronously, before the
      // first await, so the second call here sees the first one's claim.
      run1 = result.current.sendAgentMessage('mach mir ein video von einer katze')
      run2 = result.current.sendAgentMessage('mach mir ein video von einer katze')
      await Promise.all([run1, run2])
    })

    expect(calls).toBe(1)
  })

  it('COUNTER-CHECK: the SAME two-send shape on TWO DIFFERENT conversations is NOT blocked (both go through)', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/chat/completions')) return new Response('{}', { status: 200 })
      calls++
      return textZug()
    })

    const { result } = renderHook(() => useAgentChat())
    const convA = seed()
    const convB = seed()

    await act(async () => {
      useChatStore.getState().setActiveConversation(convA)
      const runA = result.current.sendAgentMessage('task-A')
      useChatStore.getState().setActiveConversation(convB)
      const runB = result.current.sendAgentMessage('task-B')
      await Promise.all([runA, runB])
    })

    // This is the negative control on the test itself, not on the fix: if
    // this ever reads 1, the guard has regressed to hook-instance-wide
    // again (the pre-B2 defect) and is blocking an unrelated conversation.
    expect(calls).toBe(2)
  })
})
