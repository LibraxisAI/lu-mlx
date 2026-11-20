/**
 * @vitest-environment jsdom
 *
 * Gegenprobe 01.10.2026: after "No" on an approval card the Code tab handed
 * the model the bare "User rejected tool call", and Mistral answered that it
 * had no tools at all. The next request now tells the model the call did not
 * run, its tools are still there, and not to repeat the same call.
 *
 * Run: npx vitest run src/hooks/__tests__/a-declined-call-tells-the-model-it-still-has-tools.test.ts
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

import { useCodex } from '../useCodex'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useCodexStore } from '../../stores/codexStore'
import { useCodexConfirmStore } from '../../stores/codexConfirmStore'
import { useGenerationStore } from '../../stores/generationStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { __resetRunStopsForTests } from '../../lib/run-stop'
import { REJECTED_CALL_FOR_MODEL } from '../../lib/rejected-call'
import { toolRegistry, registerBuiltinTools } from '../../api/mcp'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'
const sse = (...payloads: object[]) =>
  payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n'

const bodies: Array<{ messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }> = []

beforeEach(() => {
  registerBuiltinTools(toolRegistry)
  __resetRunStopsForTests()
  bodies.length = 0
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useCodexStore.setState({ modeByConversation: {}, lastPickedMode: null, parkedModeByConversation: {} })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud', cavemanMode: 'off', codexConfirmShell: true } })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, 'lu-cloud': { ...s.providers['lu-cloud'], enabled: true } },
  }))
  useModelStore.setState({ models: [], activeModel: MODEL })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/chat/completions')) return new Response('{}', { status: 200 })
    bodies.push(JSON.parse(String(init?.body)))
    const first = bodies.length === 1
    const text = first
      ? sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell_execute', arguments: '{"command":"npm test"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        )
      : sse({ choices: [{ delta: { content: 'Understood, I will not run it.' }, finish_reason: 'stop' }] })
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
})
afterEach(() => vi.restoreAllMocks())

describe('after the user says No', () => {
  it('the model reads that the call did not run and its tools are still there', async () => {
    const { result } = renderHook(() => useCodex())
    const convId = useChatStore.getState().createConversation(MODEL, '', 'codex')
    useChatStore.getState().setActiveConversation(convId)
    useCodexStore.getState().chooseCodexMode(convId, 'ask', false)

    let run!: Promise<unknown>
    act(() => { run = result.current.sendInstruction('run the tests') })
    await waitFor(() => expect(useCodexConfirmStore.getState().pending).not.toBeNull())
    act(() => useCodexConfirmStore.getState().answer(false))
    await act(async () => { await run })

    expect(bodies.length).toBeGreaterThanOrEqual(2)
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain(REJECTED_CALL_FOR_MODEL)
    expect(String(toolMsg?.content)).not.toContain('User rejected tool call')
  })
})
