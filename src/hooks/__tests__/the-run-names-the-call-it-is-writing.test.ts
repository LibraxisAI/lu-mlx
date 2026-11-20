/**
 * @vitest-environment jsdom
 *
 * Realtime pass 01.10.2026 (R1), end to end through the Agent loop: while the
 * model's tool call is still streaming, the run anchor's store names the call;
 * no placeholder block claims the model is "Thinking" (Gegenprobe 01.10.2026:
 * that chip showed for models that do not think); once the step is over the label
 * is cleared, so the anchor goes back to "Working" for the tool run and the
 * next step.
 *
 * Run: npx vitest run src/hooks/__tests__/the-run-names-the-call-it-is-writing.test.ts
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

describe('the run names the call it is writing', () => {
  it('label while the arguments stream, placeholder gone, cleared after the step', async () => {
    let push!: (b: Uint8Array) => void
    let end!: () => void
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/chat/completions')) return new Response('{}', { status: 200 })
      calls++
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            push = (b) => c.enqueue(b)
            end = () => c.close()
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })

    const { result } = renderHook(() => useAgentChat())
    const convId = useChatStore.getState().createConversation(MODEL, '')
    useChatStore.getState().setActiveConversation(convId)
    useAgentModeStore.getState().setAgentModeActive(convId, true)

    let run!: Promise<void>
    act(() => { run = result.current.sendAgentMessage('note a todo: buy milk') })
    await waitFor(() => expect(calls).toBe(1))
    await waitFor(() => expect(push).toBeTypeOf('function'))
    // The request is out, nothing has come back: the answer holds no
    // "Thinking" block, the status line alone says the run is working.
    const waiting = useChatStore.getState().conversations.find((c) => c.id === convId)!
      .messages.at(-1)!.agentBlocks ?? []
    expect(waiting.filter((b) => b.phase === 'thinking')).toEqual([])

    push(line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'todo_write', arguments: '' } }] } }] }))
    await waitFor(() => expect(useRunActivityStore.getState().activity[convId]?.label).toBe('Preparing a tool'))
    const blocks = useChatStore.getState().conversations.find((c) => c.id === convId)!
      .messages.at(-1)!.agentBlocks ?? []
    expect(blocks.filter((b) => b.phase === 'thinking')).toEqual([])

    push(line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"todos":[{"content":"buy milk","status":"pending"}]}' } }] } }] }))
    push(line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    push(enc.encode('data: [DONE]\n\n'))
    end()
    await act(async () => { await run })

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(useRunActivityStore.getState().activity[convId]).toBeUndefined()
  })
})
