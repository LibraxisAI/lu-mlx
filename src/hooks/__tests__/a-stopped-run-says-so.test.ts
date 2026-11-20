/**
 * @vitest-environment jsdom
 *
 * Gegenprobe on the real Windows build, 01.10.2026: Stop before the model's
 * first token left an empty answer bubble with only the logo. A stopped run
 * that shows nothing now says it stopped; one that already wrote keeps it.
 *
 * Run: npx vitest run src/hooks/__tests__/a-stopped-run-says-so.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

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
import { useCodex } from '../useCodex'
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
import { useRunActivityStore } from '../../stores/runActivityStore'
import { STOPPED_NOTE } from '../../lib/stopped-note'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { __resetRunStopsForTests } from '../../lib/run-stop'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'
const enc = new TextEncoder()
const line = (payload: object) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`)

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
  useRunActivityStore.setState({ activity: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off' } })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
  useModelStore.setState({ models: [], activeModel: MODEL })
})
afterEach(() => vi.restoreAllMocks())

function heldStream() {
  let push!: (b: Uint8Array) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/chat/completions')) return new Response('{}', { status: 200 })
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (b) => c.enqueue(b)
        init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  return { push: (o: object) => push(line(o)), ready: () => typeof push === 'function' }
}

function start() {
  const { result } = renderHook(() => useAgentChat())
  const convId = useChatStore.getState().createConversation(MODEL, '')
  useChatStore.getState().setActiveConversation(convId)
  useAgentModeStore.getState().setAgentModeActive(convId, true)
  let run!: Promise<void>
  act(() => { run = result.current.sendAgentMessage('write a poem') })
  return { result, convId, run: () => run }
}

const answer = (convId: string) =>
  useChatStore.getState().conversations.find((c) => c.id === convId)!.messages.filter((m) => m.role === 'assistant').at(-1)!

describe('a stopped run says so', () => {
  it('Stop before the first token: the answer is the note, not empty', async () => {
    const s = heldStream()
    const { result, convId, run } = start()
    await waitFor(() => expect(s.ready()).toBe(true))
    await act(async () => { result.current.stopAgent(); await run() })
    expect(answer(convId).content).toBe(STOPPED_NOTE)
    // The step's "Analyzing..." placeholder does not stay behind as a
    // "Thinking" chip above the note.
    expect((answer(convId).agentBlocks ?? []).filter((b) => b.phase === 'thinking')).toEqual([])
  })

  it('Stop after text arrived: the text stays, no note on top', async () => {
    const s = heldStream()
    const { result, convId, run } = start()
    await waitFor(() => expect(s.ready()).toBe(true))
    s.push({ choices: [{ delta: { content: 'Roses are red' } }] })
    await waitFor(() => expect(JSON.stringify(answer(convId))).toContain('Roses are red'))
    await act(async () => { result.current.stopAgent(); await run() })
    expect(answer(convId).content).not.toBe(STOPPED_NOTE)
    expect(JSON.stringify(answer(convId))).toContain('Roses are red')
  })

  it('Code tab: Stop before the first token leaves the note too', async () => {
    const s = heldStream()
    const { result } = renderHook(() => useCodex())
    const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
    useChatStore.getState().setActiveConversation(convId)
    let run!: Promise<unknown>
    act(() => { run = result.current.sendInstruction('create notes.md') })
    await waitFor(() => expect(s.ready()).toBe(true))
    await act(async () => { result.current.stopCodex(); await run })
    expect(answer(convId).content).toBe(STOPPED_NOTE)
  })
})
