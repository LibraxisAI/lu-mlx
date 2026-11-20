/**
 * @vitest-environment jsdom
 *
 * Runde 5 Nachtrag (review-lanes.md Runde 2, Grep-Audit dieser Runde,
 * The owner's addendum after it): `useABCompare.ts` fires two genuine
 * `provider.chatStream` calls per round, one per model, with NO reference
 * to `run-lanes.ts` at all. Confirmed by reading the file: both `streamA`
 * and `streamB` call `getProviderForModel(...).provider.chatStream(...)`
 * directly.
 *
 * Two models that BOTH resolve to the local lane would have fired at the
 * same one-slot built-in engine at once (`Promise.all([streamA(), streamB()])`),
 * the same VRAM-swap Blocker A and B this round were about. Even with only
 * ONE local side, the round still needs to book the lane, or it can race an
 * unrelated local conversation running elsewhere in the app.
 *
 * Fix: the whole round now runs inside `runInLane`. If EITHER side is local,
 * the round holds the local lane. If BOTH sides are local, they run one
 * after another under that SAME held booking (not queued behind each other,
 * which would just lock the round out against itself). A mixed or all-cloud
 * pairing keeps the original parallel behaviour, since at most one side ever
 * touches the shared engine.
 *
 * Run: npx vitest run src/hooks/__tests__/ab-compare-bucht-lokale-spur.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../lib/run-lane-of-model', () => ({
  laneOf: (model: string) => (model.startsWith('cloud::') ? 'cloud' : 'local'),
  currentLaneFacts: () => ({ openaiSlotIsLocal: true, ollamaBaseIsLocal: true }),
}))

/** A hand-controlled `provider.chatStream`-shaped async generator. */
function controllableChatStream() {
  const chunks: Array<{ content: string; done: boolean }> = []
  let notify: (() => void) | null = null
  const push = (content: string) => { chunks.push({ content, done: false }); notify?.(); notify = null }
  const done = () => { chunks.push({ content: '', done: true }); notify?.(); notify = null }
  async function* gen() {
    for (;;) {
      if (chunks.length === 0) await new Promise<void>((res) => { notify = res })
      while (chunks.length) {
        const c = chunks.shift()!
        yield c
        if (c.done) return
      }
    }
  }
  return { stream: gen(), push, done }
}

let chatStreamCalls: string[] = []
let streams: Record<string, ReturnType<typeof controllableChatStream>> = {}
vi.mock('../../api/providers', () => ({
  getProviderForModel: (model: string) => ({
    provider: {
      chatStream: (_modelId: string, _messages: unknown, _opts: unknown) => {
        chatStreamCalls.push(model)
        return streams[model].stream
      },
    },
    modelId: model,
  }),
  getProviderIdFromModel: (model: string) => (model.startsWith('cloud::') ? 'lu-cloud' : 'openai'),
}))

import { useABCompare } from '../useABCompare'
import { useCompareStore } from '../../stores/compareStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { __resetRunLanesForTests, localLaneHolder, queuedRunIds } from '../../lib/run-lanes'
import { DEFAULT_SETTINGS } from '../../lib/constants'

const LOCAL_A = 'local::model-a'
const LOCAL_B = 'local::model-b'
const CLOUD_A = 'cloud::model-a'
const CLOUD_B = 'cloud::model-b'

beforeEach(() => {
  __resetRunLanesForTests()
  chatStreamCalls = []
  streams = {}
  useCompareStore.setState({
    isComparing: true, modelA: '', modelB: '',
    messagesA: [], messagesB: [], statsA: null, statsB: null,
    isStreamingA: false, isStreamingB: false,
  })
  // contextDecay: false steers chat-send-budget's notaus, so sendCompare
  // never calls the async getModelMaxTokens at all, keeping this test's
  // provider mock small and deterministic.
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, contextDecay: false },
  })
})
afterEach(() => vi.restoreAllMocks())

function seed(modelA: string, modelB: string, streamA = controllableChatStream(), streamB = controllableChatStream()) {
  useCompareStore.setState({ modelA, modelB })
  streams[modelA] = streamA
  streams[modelB] = streamB
  return { streamA, streamB }
}

describe('A/B Compare bucht die lokale Spur', () => {
  it('zwei lokale Modelle laufen NACHEINANDER unter EINER gehaltenen Buchung, nicht gleichzeitig', async () => {
    const { streamA, streamB } = seed(LOCAL_A, LOCAL_B)
    const { result } = renderHook(() => useABCompare())

    let round: Promise<void> = Promise.resolve()
    await act(async () => {
      round = result.current.sendCompare('same prompt to both')
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    // Only A has been asked so far: B waits for A to finish, same booking.
    expect(chatStreamCalls).toEqual([LOCAL_A])
    expect(localLaneHolder()).toBe('lib:ab-compare')
    // Not a queued SEPARATE run: B is part of the SAME held round.
    expect(queuedRunIds()).toEqual([])

    // A different, genuinely separate local conversation must queue while
    // the round holds the lane.
    const otherAdmit = await import('../../lib/run-lanes').then((m) => m.admit('local', 'conv-elsewhere', () => {}))
    expect(otherAdmit).toBe('queued')

    await act(async () => {
      streamA.push('answer-a')
      streamA.done()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    // A is done, B now runs.
    expect(chatStreamCalls).toEqual([LOCAL_A, LOCAL_B])

    await act(async () => {
      streamB.push('answer-b')
      streamB.done()
      await round
    })

    expect(useCompareStore.getState().messagesA.at(-1)?.content).toBe('answer-a')
    expect(useCompareStore.getState().messagesB.at(-1)?.content).toBe('answer-b')
    expect(localLaneHolder()).toBe('conv-elsewhere')
    expect(queuedRunIds()).toEqual([])
  })

  it('gemischtes Paar (ein lokales, ein Cloud-Modell) laeuft weiterhin PARALLEL, haelt aber die lokale Spur', async () => {
    const { streamA, streamB } = seed(LOCAL_A, CLOUD_B)
    const { result } = renderHook(() => useABCompare())

    let round: Promise<void> = Promise.resolve()
    await act(async () => {
      round = result.current.sendCompare('same prompt to both')
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    // Both fired at once: only ONE side touches the shared local engine.
    expect(chatStreamCalls.sort()).toEqual([CLOUD_B, LOCAL_A].sort())
    expect(localLaneHolder()).toBe('lib:ab-compare')

    await act(async () => {
      streamA.push('answer-a'); streamA.done()
      streamB.push('answer-b'); streamB.done()
      await round
    })

    expect(localLaneHolder()).toBeNull()
  })

  it('GEGENPROBE: zwei Cloud-Modelle buchen gar keine lokale Spur', async () => {
    const { streamA, streamB } = seed(CLOUD_A, CLOUD_B)
    const { result } = renderHook(() => useABCompare())

    let round: Promise<void> = Promise.resolve()
    await act(async () => {
      round = result.current.sendCompare('same prompt to both')
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(chatStreamCalls.sort()).toEqual([CLOUD_A, CLOUD_B].sort())
    expect(localLaneHolder()).toBeNull()

    await act(async () => {
      streamA.push('answer-a'); streamA.done()
      streamB.push('answer-b'); streamB.done()
      await round
    })
  })
})
