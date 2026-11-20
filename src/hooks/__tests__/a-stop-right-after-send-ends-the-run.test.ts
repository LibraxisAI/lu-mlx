/**
 * @vitest-environment jsdom
 *
 * Gegenprobe on the real Windows build, 01.10.2026: Stop pressed in the same
 * moment as Send, while the run was still preparing (before its first model
 * request). The Stop was taken, then the run's own start wiped it and marked
 * itself generating again: "Working" counted past a minute with nothing
 * behind it, only a second Stop ended it, and the answer read "rephrase, or
 * turn off Think". The same gap in the Code tab let the whole run go ahead.
 *
 * The preparing window is held open here by the workspace lookup every run
 * awaits before its first request.
 *
 * Run: npx vitest run src/hooks/__tests__/a-stop-right-after-send-ends-the-run.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const gate = vi.hoisted(() => ({ held: null as null | { reached: boolean; release: () => void } }))

vi.mock('../../api/workspace-slug', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../api/workspace-slug')>()
  return {
    ...real,
    resolveChatWorkspaceSlug: async (...args: Parameters<typeof real.resolveChatWorkspaceSlug>) => {
      const g = gate.held
      if (g) {
        g.reached = true
        await new Promise<void>((r) => { g.release = r })
      }
      return real.resolveChatWorkspaceSlug(...args)
    },
  }
})
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

let modelRequests = 0
beforeEach(() => {
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  gate.held = { reached: false, release: () => {} }
  modelRequests = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).includes('/chat/completions')) modelRequests++
    return new Response('{}', { status: 200 })
  })
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
afterEach(() => {
  gate.held = null
  vi.restoreAllMocks()
})

const answer = (convId: string) =>
  useChatStore.getState().conversations.find((c) => c.id === convId)!.messages.filter((m) => m.role === 'assistant').at(-1)

function settled(convId: string) {
  const g = useGenerationStore.getState()
  return { generating: !!g.generating[convId], aborter: !!g.aborters[convId] }
}

describe('Stop pressed while the run is still preparing', () => {
  it('Agent: the run ends, nothing keeps "Working" alive, the answer says it stopped', async () => {
    const { result } = renderHook(() => useAgentChat())
    const convId = useChatStore.getState().createConversation(MODEL, '')
    useChatStore.getState().setActiveConversation(convId)
    useAgentModeStore.getState().setAgentModeActive(convId, true)
    let run!: Promise<void>
    act(() => { run = result.current.sendAgentMessage('write a poem') })
    await waitFor(() => expect(gate.held!.reached).toBe(true))
    expect(result.current.isAgentRunning).toBe(true)

    act(() => result.current.stopAgent(convId))
    await act(async () => { gate.held!.release(); await run })

    expect(settled(convId)).toEqual({ generating: false, aborter: false })
    expect(result.current.isAgentRunning).toBe(false)
    expect(modelRequests).toBe(0)
    expect(answer(convId)?.content).toBe(STOPPED_NOTE)
  })

  it('Code: the Stop is not wiped by the run starting, no request goes out', async () => {
    const { result } = renderHook(() => useCodex())
    const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
    useChatStore.getState().setActiveConversation(convId)
    let run!: Promise<unknown>
    act(() => { run = result.current.sendInstruction('create notes.md') })
    await waitFor(() => expect(gate.held!.reached).toBe(true))

    act(() => result.current.stopCodex(convId))
    await act(async () => { gate.held!.release(); await run })

    expect(settled(convId)).toEqual({ generating: false, aborter: false })
    expect(result.current.isRunning).toBe(false)
    expect(modelRequests).toBe(0)
    expect(answer(convId)?.content).toBe(STOPPED_NOTE)
  })
})
