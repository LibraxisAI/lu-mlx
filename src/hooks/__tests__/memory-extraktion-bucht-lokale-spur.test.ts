/**
 * @vitest-environment jsdom
 *
 * Runde 4 (review-lanes.md Blocker 1+6, Schritt 1 "andere Verbraucher der
 * lokalen Spur"): `extractMemoriesFromPair` (useMemory.ts) fires a genuine
 * inference call, unawaited, from inside useAgentChat.ts and useCodex.ts,
 * AFTER the visible turn has landed. Before this fix it ran straight against
 * `provider.chatStream`, invisible to `lib/run-lanes.ts`. A second local
 * conversation admitted right after the visible turn released its own lane
 * could then answer AT THE SAME TIME as this straggling extraction call, on
 * the same engine: exactly the VRAM-swap race the lane exists to prevent,
 * just started one level above where run-lanes.ts can see it.
 *
 * This file proves the fix directly against the real `lib/run-lanes.ts`
 * module (nothing about admit/release/queue is mocked): while an extraction
 * call is mid-stream, a second local conversation that tries to admit must
 * queue behind it, and is only promoted once the extraction's own call
 * releases.
 *
 * A second question sits right next to it: the booking identity must NOT be
 * the bare `conversationId`, because `run-slot.ts` treats a second `runInLane`
 * call under the SAME id, while the first is still active, as a benign
 * re-entry (the foreground sub-agent case) and lets it through immediately
 * without ever registering a real queue wait. Since extraction fires while
 * the visible turn's own `runInLane` body has not returned yet, booking
 * under the bare id would silently take that fast path and protect nothing.
 *
 * NEGATIVE CONTROL (both run by hand on 18.09., exact numbers below, then
 * reverted and confirmed green again):
 *  1. Replaced the `runInLane(...)` call with a plain `await (async () => {
 *     ... })()`, i.e. ran the same body without ever booking a lane. Red
 *     with `expected null to be 'conv-a::memory-extraction'` (localLaneHolder
 *     stayed `null` the whole time; nothing ever registered).
 *  2. Restored the `runInLane` wrap but booked it under the bare
 *     `conversationId` instead of the suffixed one. Red with
 *     `expected 'conv-a' to be 'conv-a::memory-extraction'`: the bare id hit
 *     `run-slot.ts`'s same-conversation re-entry fast path (the visible
 *     turn's own depth counter was still greater than zero) and became the
 *     holder under the WRONG identity, one that the visible turn's own
 *     `finally` releases regardless of whether extraction is still running.
 *
 * Run: npx vitest run src/hooks/__tests__/memory-extraktion-bucht-lokale-spur.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { useGenerationStore } from '../../stores/generationStore'
import { useAgentTaskStore } from '../../stores/agentTaskStore'
import { useAgentLoopStore } from '../../stores/agentLoopStore'
import { stopAllBackgroundWork } from '../../lib/background-shutdown'
import { admit, localLaneHolder, queuedRunIds, __resetRunLanesForTests } from '../../lib/run-lanes'

const chatStream = vi.fn()
const addMemory = vi.fn(() => 'mem-1')
/** The `AbortSignal` the extraction's last `chatStream` call was given, so a
 *  test can check whether `stopAllBackgroundWork` actually reached it. */
let lastSignal: AbortSignal | undefined

let activeModel = 'qwen3:8b'
let resolveStream: (() => void) | null = null

vi.mock('../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel, models: [] }) },
}))
// Stable references for `settings` and `entries`: `extractMemoriesFromPair`'s
// own write guard compares `getState().entries` against the snapshot it took
// at the start via `!==`, exactly the check that catches a memory edited
// underneath a running extraction. A mock that hands back a FRESH array or
// object literal on every call looks changed on every read, exactly like a
// real edit, and the guard correctly revokes the whole call before it ever
// reaches `chatStream`.
const memorySettings = { autoExtractEnabled: true, autoExtractInAllModes: false }
const memoryEntries: unknown[] = []
vi.mock('../../stores/memoryStore', () => ({
  useMemoryStore: {
    getState: () => ({
      settings: memorySettings,
      entries: memoryEntries,
      addMemory,
      removeMemory: vi.fn(),
      applyWriteDecision: vi.fn(),
    }),
  },
}))
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({
      providers: { openai: { enabled: true, isLocal: true }, anthropic: { enabled: false } },
    }),
  },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { memoryCloudOptIn: false, contextWindowOverride: 0 } }),
  },
}))
vi.mock('../../api/providers', () => ({
  getProviderForModel: () => ({ provider: { chatStream }, modelId: 'qwen3:8b' }),
  getProviderIdFromModel: () => 'ollama',
}))
vi.mock('../../api/rag', () => ({
  generateEmbeddings: vi.fn(async () => [[]]),
  cosineSimilarity: vi.fn(() => 0),
}))
vi.mock('../../lib/memoryEmbedDB', () => ({
  loadVectors: vi.fn(async () => new Map()),
}))

const { extractMemoriesFromPair } = await import('../useMemory')
/** The visible turn sent no context window; this file is about the lane. */
const NO_WINDOW = {}

/** A stream that hangs until the test resolves it by hand, mid-extraction,
 *  or until its `signal` aborts, mirroring the shape a real provider stream
 *  takes when its underlying fetch is cancelled mid-flight. */
function haengenderStream(signal?: AbortSignal) {
  return (async function* () {
    yield { content: '', done: false }
    await new Promise<void>((resolve, reject) => {
      resolveStream = resolve
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    yield { content: '{"shouldSave": false, "memories": []}', done: true }
  })()
}

beforeEach(() => {
  __resetRunLanesForTests()
  useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  useAgentTaskStore.setState({ byConv: {} })
  useAgentLoopStore.setState({ loops: {} })
  chatStream.mockReset()
  chatStream.mockImplementation((_model: string, _messages: unknown, options?: { signal?: AbortSignal }) => {
    lastSignal = options?.signal
    return haengenderStream(options?.signal)
  })
  addMemory.mockClear()
  useCloudAuthStore.getState().setSignedOut()
  resolveStream = null
  lastSignal = undefined
  activeModel = 'qwen3:8b'
})

describe('extractMemoriesFromPair bucht die lokale Spur', () => {
  it('eine zweite lokale Unterhaltung wartet, waehrend die Extraktion mitten im Strom haengt', async () => {
    // Turns 1 and 2 are rate-limited away (every 3rd turn extracts); the
    // 3rd actually fires the call and hangs on `haengenderStream`.
    await extractMemoriesFromPair('frage 1', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    await extractMemoriesFromPair('frage 2', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    const dritte = extractMemoriesFromPair('frage 3', 'x'.repeat(200), 'conv-a', NO_WINDOW)

    // Give the extraction's async prologue (guards, resolveSilentCall, the
    // runInLane admission) room to run
    // and reach the stream.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(localLaneHolder()).toBe('conv-a::memory-extraction')

    // A second, genuinely different conversation tries the local lane while
    // the extraction still holds it.
    const zweiterAdmit = admit('local', 'conv-b', () => {})
    expect(zweiterAdmit).toBe('queued')
    expect(queuedRunIds()).toEqual(['conv-b'])

    // Let the extraction finish; it must release the lane and hand it to
    // the waiting conversation.
    resolveStream?.()
    await dritte

    expect(localLaneHolder()).toBe('conv-b')
    expect(queuedRunIds()).toEqual([])
  })

  // Runde 5 Folgeposten 3 (review-lanes.md Runde 2, Punkt 5 Fund 4): a
  // RUNNING extraction used to be unstoppable (`abort: () => {}`), so
  // `stopAllBackgroundWork` (sign-out, window close, app quit) reached a
  // QUEUED extraction but let a RUNNING one bill to completion after the
  // user believed they had left.
  it('stopAllBackgroundWork bricht eine LAUFENDE Extraktion wirklich ab', async () => {
    await extractMemoriesFromPair('frage 1', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    await extractMemoriesFromPair('frage 2', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    const dritte = extractMemoriesFromPair('frage 3', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(localLaneHolder()).toBe('conv-a::memory-extraction')
    expect(lastSignal?.aborted).toBe(false)

    stopAllBackgroundWork()

    expect(lastSignal?.aborted).toBe(true)
    // The extraction's own outer try/catch swallows the resulting
    // AbortError by contract (extraction failures are always silent), so the
    // call still resolves cleanly, it just never saves anything.
    await dritte
    expect(addMemory).not.toHaveBeenCalled()
    expect(localLaneHolder()).toBeNull()
  })

  it('GEGENPROBE: eine cloud-Unterhaltung braucht auf eine lokale Extraktion nicht zu warten', async () => {
    await extractMemoriesFromPair('frage 1', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    await extractMemoriesFromPair('frage 2', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    const dritte = extractMemoriesFromPair('frage 3', 'x'.repeat(200), 'conv-a', NO_WINDOW)
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(admit('cloud', 'conv-cloud', () => {})).toBe('started')

    resolveStream?.()
    await dritte
  })
})
