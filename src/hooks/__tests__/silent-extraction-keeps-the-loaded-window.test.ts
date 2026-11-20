/**
 * @vitest-environment jsdom
 *
 * The silent memory extraction never makes a local backend reload the model.
 *
 * Ollama allocates the context at load time and loads the model again for
 * every request that carries another num_ctx. The extraction used to resolve
 * a window of its own (`resolveAgentNumCtx`), and that was wrong in three
 * ways, each of them a full model load nobody asked for:
 *
 *   - after a plain chat turn: the chat caps its window at DEFAULT_CONTEXT_CAP
 *     (16384), the extraction asked for the agent cap (32768);
 *   - after a voice session: the session sends no window at all, the
 *     extraction sent the chat setting (262144 in the hand test of 10.10.2026);
 *   - the write-decision call right after the extraction sent none, whatever
 *     the extraction itself had sent.
 *
 * Now no silent call picks a window at all. The provider sends an Ollama
 * model the window it was last sent (`ollamaNumCtx` in api/ollama.ts), which
 * is proven on the wire in api/__tests__/one-window-per-ollama-model.test.ts.
 * What is held here is this file's half: the extraction names no window, in
 * either of its two calls, except after the one turn the app did not send.
 * The calls also switch reasoning off where the model has a switch, and the
 * whole thing has a time limit.
 *
 * Run: npx vitest run src/hooks/__tests__/silent-extraction-keeps-the-loaded-window.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { useGenerationStore } from '../../stores/generationStore'
import { localLaneHolder, __resetRunLanesForTests } from '../../lib/run-lanes'

interface SentOptions { window?: string; contextWindow?: number; thinking?: boolean; maxTokens?: number; signal?: AbortSignal }
const chatStream = vi.fn()
const addMemory = vi.fn(() => 'mem-new')
const removeMemory = vi.fn()
const applyWriteDecision = vi.fn()

let activeModel = 'qwen3:8b'
const memorySettings = { autoExtractEnabled: true, autoExtractInAllModes: false }
let memoryEntries: unknown[] = []

vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel, models: [] }) },
}))
vi.mock('../../stores/memoryStore', () => ({
  useMemoryStore: {
    getState: () => ({
      settings: memorySettings,
      entries: memoryEntries,
      memoryCollectionRevision: 0,
      addMemory,
      removeMemory,
      applyWriteDecision,
    }),
  },
}))
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: { openai: { enabled: false, isLocal: true }, anthropic: { enabled: false } } }),
  },
}))
// The chat setting of the hand test. Nothing in the extraction may read it.
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { memoryCloudOptIn: false, contextWindowOverride: 262144 } }),
  },
}))
vi.mock('../../api/providers', () => ({
  getProviderForModel: (name: string) => ({ provider: { chatStream }, modelId: name }),
  getProviderIdFromModel: () => 'ollama',
}))
const generateEmbeddings = vi.fn(async () => [[] as number[]])
const loadVectors = vi.fn(async () => new Map<string, { dim: number; vector: number[] }>())
vi.mock('../../api/rag', () => ({
  generateEmbeddings: () => generateEmbeddings(),
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0),
}))
vi.mock('../../lib/memoryEmbedDB', () => ({ loadVectors: () => loadVectors() }))

const { extractMemoriesFromPair, SILENT_EXTRACTION_LIMIT_MS } = await import('../useMemory')

const NOTHING_TO_SAVE = '{"shouldSave": false, "memories": []}'
const ONE_MEMORY = JSON.stringify({
  shouldSave: true,
  memories: [{ type: 'user', title: 'Works as a baker', description: 'job', content: 'The user is a baker.', tags: [] }],
})

function answering(text: string) {
  return () => (async function* () { yield { content: text, done: true } })()
}
/** Hangs until its signal aborts, like a provider stream whose fetch is cancelled. */
function hanging(_model: string, _messages: unknown, options?: SentOptions) {
  return (async function* () {
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    yield { content: ONE_MEMORY, done: true }
  })()
}
const sent = (call: number): SentOptions => chatStream.mock.calls[call][2] as SentOptions
const LONG_REPLY = 'x'.repeat(200)
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

beforeEach(() => {
  __resetRunLanesForTests()
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useCloudAuthStore.getState().setSignedOut()
  chatStream.mockReset()
  chatStream.mockImplementation(answering(NOTHING_TO_SAVE))
  addMemory.mockClear()
  removeMemory.mockClear()
  applyWriteDecision.mockClear()
  generateEmbeddings.mockReset()
  generateEmbeddings.mockResolvedValue([[]])
  loadVectors.mockReset()
  loadVectors.mockResolvedValue(new Map())
  memoryEntries = []
  activeModel = 'qwen3:8b'
})
afterEach(() => { vi.useRealTimers() })

describe('the window of the silent extraction', () => {
  it('names no window of its own, whatever the chat setting says', async () => {
    await extractMemoriesFromPair('question', LONG_REPLY, 'conv-1', { digest: true })
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(sent(0).window).toBeUndefined()
    expect(sent(0)).not.toHaveProperty('contextWindow')
  })

  it('after a turn the app did not send it asks for none to be sent at all', async () => {
    await extractMemoriesFromPair('question', LONG_REPLY, 'remote-1', { digest: true, window: 'backend-default' })
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(sent(0).window).toBe('backend-default')
  })

  it('the write-decision call says the same as the extraction before it', async () => {
    // One stored memory of the same type whose vector sits in the merge band
    // (cosine 0.8), so the second silent call of the turn really goes out.
    memoryEntries = [{ id: 'old-1', type: 'user', title: 'Job', content: 'The user bakes bread.', scope: undefined }]
    generateEmbeddings.mockResolvedValue([[1, 0]])
    loadVectors.mockResolvedValue(new Map([['old-1', { dim: 2, vector: [0.8, 0.6] }]]))
    // The speculative add changes the list, as the real store does.
    addMemory.mockImplementation(() => { memoryEntries = [...memoryEntries]; return 'mem-new' })
    for (const window of [undefined, 'backend-default'] as const) {
      chatStream.mockReset()
      chatStream
        .mockImplementationOnce(answering(ONE_MEMORY))
        .mockImplementationOnce(answering('{"action": "ADD"}'))
      memoryEntries = [{ id: 'old-1', type: 'user', title: 'Job', content: 'The user bakes bread.', scope: undefined }]

      await extractMemoriesFromPair('I am a baker', LONG_REPLY, 'conv-1', { digest: true, window })

      expect(chatStream).toHaveBeenCalledTimes(2)
      expect(sent(0).window).toBe(window)
      expect(sent(1).window).toBe(window)
    }
  })

  it('the extraction resolves nothing by itself, and only the remote bridge asks for no window', () => {
    const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
    expect(read('hooks/useMemory.ts')).not.toMatch(/resolveAgentNumCtx|contextWindowOverride|ollamaNumCtx\(|num_ctx:/)
    for (const caller of ['hooks/useChat.ts', 'hooks/useAgentChat.ts', 'hooks/useCodex.ts', 'api/voice-history.ts']) {
      expect(read(caller), caller).not.toMatch(/backend-default/)
    }
    expect(read('components/layout/AppShell.tsx')).toMatch(/extractMemoriesFromPair\(userMsg[\s\S]{0,900}?window: 'backend-default'/)
  })
})

describe('reasoning in the silent extraction', () => {
  it('is switched off for a model that has a switch', async () => {
    activeModel = 'qwen3:8b'
    await extractMemoriesFromPair('question', LONG_REPLY, 'conv-1', { digest: true })
    expect(sent(0).thinking).toBe(false)
  })

  it('is left out for a model that has none, so the request carries no unknown field', async () => {
    activeModel = 'llama3.1:8b'
    await extractMemoriesFromPair('question', LONG_REPLY, 'conv-1', { digest: true })
    expect(sent(0).thinking).toBeUndefined()
  })
})

describe('the time limit of the silent extraction', () => {
  it('closes the request when the limit is reached, saves nothing and frees the lane', async () => {
    vi.useFakeTimers()
    chatStream.mockImplementation(hanging)

    const run = extractMemoriesFromPair('question', LONG_REPLY, 'conv-1', { digest: true })
    await tick()
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(localLaneHolder()).toBe('conv-1::memory-extraction')

    await vi.advanceTimersByTimeAsync(SILENT_EXTRACTION_LIMIT_MS - 1)
    expect(sent(0).signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(sent(0).signal?.aborted).toBe(true)
    await expect(run).resolves.toBeUndefined()
    expect(addMemory).not.toHaveBeenCalled()
    expect(localLaneHolder()).toBeNull()
  })

  it('does not count the wait behind a visible turn', async () => {
    vi.useFakeTimers()
    const { runInLane } = await import('../../lib/run-slot')
    let endChat: () => void = () => {}
    const chat = runInLane({ conversationId: 'chat-1', lane: 'local', abort: () => {} }, () => new Promise<void>((r) => { endChat = r }))
    await tick()

    const run = extractMemoriesFromPair('question', LONG_REPLY, 'conv-2', { digest: true })
    await vi.advanceTimersByTimeAsync(SILENT_EXTRACTION_LIMIT_MS * 2)
    // Still queued, not thrown away: it holds no model while it waits.
    expect(chatStream).not.toHaveBeenCalled()

    endChat()
    await chat
    await vi.advanceTimersByTimeAsync(0)
    await run
    expect(chatStream).toHaveBeenCalledTimes(1)
  })

  it('a memory that arrives after the cut is not written', async () => {
    vi.useFakeTimers()
    // The stream ignores the abort and still delivers a memory afterwards.
    let deliver: () => void = () => {}
    chatStream.mockImplementation(() => (async function* () {
      await new Promise<void>((r) => { deliver = r })
      yield { content: ONE_MEMORY, done: true }
    })())

    const run = extractMemoriesFromPair('question', LONG_REPLY, 'conv-1', { digest: true })
    await tick()
    await vi.advanceTimersByTimeAsync(SILENT_EXTRACTION_LIMIT_MS)
    deliver()
    await run

    expect(addMemory).not.toHaveBeenCalled()
  })
})
