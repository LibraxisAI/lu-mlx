/**
 * Hand test on the Mac, 10.10.2026 (3.0.6, 000ba4eb): when a voice session
 * ended, the memory digest (`VoiceHistory.finish` -> `extractMemoriesFromPair`)
 * went to the chat model with the context window from the chat settings
 * (262144). The session itself had talked to Ollama over /v1/chat/completions,
 * which carries no num_ctx, so the model was loaded with Ollama's own default.
 * Ollama reloads a model for every other num_ctx: its log shows the 27B runner
 * starting again with `-c 262144` in the second the session ended, and then
 * computing for 91 seconds while the next model could not load.
 *
 * This file was written as a probe that pinned that behaviour (branch
 * probe/load-c, "voice-ende-belegt-das-modell"). It now states the opposite:
 *
 *   1. The digest carries no context window of its own, like the session.
 *   2. It does not ask the model to think.
 *   3. A model control reaches it: the request is closed.
 *
 * Run: npx vitest run src/api/__tests__/a-voice-session-end-leaves-the-model-as-loaded.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const BIG = 'hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q6_K'
const SMALL = 'qwen3.8:9b'
/** Was der Nutzer im Chat als Kontextfenster eingestellt hat. */
const CHAT_OVERRIDE = 262144

interface StreamCall {
  model: string
  options: { contextWindow?: number; thinking?: boolean; signal?: AbortSignal }
}
const calls: StreamCall[] = []
let letGo: (() => void) | null = null
let activeModel = BIG

/** Ein Aufruf, der so lange laeuft, bis der Test ihn loslaesst. */
const chatStream = vi.fn((model: string, _messages: unknown, options: StreamCall['options'] = {}) => {
  calls.push({ model, options })
  return (async function* () {
    await new Promise<void>((resolve, reject) => {
      letGo = resolve
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    yield { content: '{"shouldSave": false, "memories": []}', done: true }
  })()
})

// Der Verlauf braucht vom Chat-Speicher nur die Schreibgriffe.
const chat = {
  conversations: [{ id: 'voice-1', messages: [] as Array<{ id: string; role: string; content: string }> }],
  addMessage: (_id: string, message: { id: string; role: string; content: string }) => { chat.conversations[0].messages.push(message) },
  updateMessageContent: vi.fn(),
  updateMessageThinking: vi.fn(),
  updateMessageAgentBlocks: vi.fn(),
  deleteConversation: vi.fn(),
}
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => chat } }))
vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel, models: [{ name: BIG, type: 'text' }, { name: SMALL, type: 'text' }] }) },
}))
// Dieselbe Liste bei jedem Lesen: eine neue gilt der Extraktion als geaendertes Gedaechtnis.
const NO_MEMORIES: never[] = []
vi.mock('../../stores/memoryStore', () => ({
  useMemoryStore: {
    getState: () => ({
      settings: { autoExtractEnabled: true, autoExtractInAllModes: false },
      entries: NO_MEMORIES,
      memoryCollectionRevision: 0,
      addMemory: vi.fn(() => 'mem-1'),
      removeMemory: vi.fn(),
      applyWriteDecision: vi.fn(),
    }),
  },
}))
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: { openai: { enabled: false, isLocal: true }, anthropic: { enabled: false }, ollama: { enabled: true, isLocal: true } } }),
  },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { memoryCloudOptIn: false, contextWindowOverride: CHAT_OVERRIDE } }) },
}))
vi.mock('../providers', () => ({
  getProviderForModel: (name: string) => ({ provider: { chatStream }, modelId: name }),
  getProviderIdFromModel: () => 'ollama',
}))
vi.mock('../rag', () => ({ generateEmbeddings: vi.fn(async () => [[]]), cosineSimilarity: vi.fn(() => 0) }))
vi.mock('../../lib/memoryEmbedDB', () => ({ loadVectors: vi.fn(async () => new Map()) }))

const { VoiceHistory } = await import('../voice-history')
const { yieldSilentLocalRuns } = await import('../../lib/silent-runs')
const { useGenerationStore } = await import('../../stores/generationStore')
const { __resetRunLanesForTests } = await import('../../lib/run-lanes')

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

describe('the end of a voice session', () => {
  beforeEach(() => {
    calls.length = 0
    letGo = null
    activeModel = BIG
    __resetRunLanesForTests()
    useGenerationStore.setState({ runs: {}, aborters: {} })
  })

  function endASession(): void {
    const history = new VoiceHistory({ conversationId: 'voice-1', modelId: BIG })
    history.userSaid('Tell me about the plan for this afternoon, in detail.')
    history.botText('x'.repeat(200))
    history.botTurnEnded()
    // Stop, or leaving the surface: teardown() calls finish().
    history.finish()
  }

  it('sends the digest without a context window of its own and without thinking', async () => {
    endASession()
    await settle()

    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe(BIG)
    // The chat setting (262144) must not ride along: the session sent none.
    expect(calls[0].options.contextWindow).toBeUndefined()
    expect(calls[0].options.thinking).not.toBe(true)

    letGo?.()
    await settle()
  })

  it('is closed by a model control instead of running on', async () => {
    endASession()
    await settle()
    expect(calls[0].options.signal?.aborted).toBe(false)

    // What the picker, the row switches and "Unload all models" call.
    expect(yieldSilentLocalRuns()).toBe(1)

    expect(calls[0].options.signal?.aborted).toBe(true)
    await settle()
  })
})
