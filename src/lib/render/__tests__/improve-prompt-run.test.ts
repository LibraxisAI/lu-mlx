import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const calls = vi.hoisted(() => ({
  list: [] as { model: string; messages: { role: string; content: string }[]; opts: Record<string, unknown> }[],
  lanes: [] as { id: string; lane: string }[],
}))
const plan = vi.hoisted(() => ({
  chunks: [] as string[],
  throws: null as Error | null,
  hangs: false,
  provider: 'lu-cloud' as string,
  lane: 'cloud' as 'cloud' | 'local',
  queued: false,
  thinkCompatible: true,
}))

vi.mock('../../../api/providers', () => ({
  getProviderIdFromModel: () => plan.provider,
  getProviderForModel: (name: string) => ({
    modelId: name.replace(/^[a-z-]+::/, ''),
    provider: {
      async *chatStream(model: string, messages: { role: string; content: string }[], opts: Record<string, unknown>) {
        calls.list.push({ model, messages, opts })
        if (plan.throws) throw plan.throws
        if (plan.hangs) await new Promise(() => {})
        for (const c of plan.chunks) yield { content: c, done: false }
        yield { content: '', done: true }
      },
    },
  }),
}))
vi.mock('../../model-compatibility', () => ({ isThinkingCompatible: () => plan.thinkCompatible }))
vi.mock('../../run-lane-of-model', () => ({ laneOf: () => plan.lane, currentLaneFacts: () => ({}) }))
vi.mock('../../run-slot', () => ({
  runInLane: async (o: { conversationId: string; lane: string }, body: () => Promise<void>) => {
    calls.lanes.push({ id: o.conversationId, lane: o.lane })
    if (plan.queued) return 'cancelled-while-queued'
    await body()
    return 'ran'
  },
}))

import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { CLOUD_HELPER_MODEL, helperModelFor } from '../../cloud-helper-model'
import { improveAvailabilityFor, improvePrompt } from '../improve-prompt-run'
import { IMPROVE_TIMEOUT_MS } from '../improve-prompt'

afterEach(() => { vi.useRealTimers() })

beforeEach(() => {
  calls.list.length = 0
  calls.lanes.length = 0
  plan.chunks = ['A red fox ', 'in deep snow.']
  plan.throws = null
  plan.hangs = false
  plan.provider = 'lu-cloud'
  plan.lane = 'cloud'
  plan.queued = false
  plan.thinkCompatible = true
  useModelStore.setState({ activeModel: 'lu-cloud::chat-model', models: [] })
  useSettingsStore.setState((st) => ({ settings: { ...st.settings, appMode: 'local' } }))
})

describe('Improve my prompt: Lauf (Desktop)', () => {
  it('ein haengender Aufruf endet nach der Frist als failed, lokal nach der doppelten', async () => {
    for (const [lane, limit] of [['cloud', IMPROVE_TIMEOUT_MS], ['local', IMPROVE_TIMEOUT_MS * 2]] as const) {
      vi.useFakeTimers()
      calls.list.length = 0
      plan.hangs = true
      plan.lane = lane
      const run = improvePrompt('x', { kind: 'image' })
      let settled = false
      void run.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(limit - 1)
      expect(settled, lane).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await run).toEqual({ status: 'failed' })
      expect((calls.list[0].opts.signal as AbortSignal).aborted).toBe(true)
      vi.useRealTimers()
    }
  })

  it('Cancel beendet auch einen Aufruf, der auf den Abbruch nicht hoert', async () => {
    plan.hangs = true
    const ac = new AbortController()
    const run = improvePrompt('x', { kind: 'image' }, ac.signal)
    await new Promise((r) => setTimeout(r, 0))
    ac.abort()
    expect(await run).toEqual({ status: 'failed' })
    expect((calls.list[0].opts.signal as AbortSignal).aborted).toBe(true)
  })

  it('schreibt mit dem gewaehlten Chatmodell um und liefert die neue Fassung', async () => {
    const out = await improvePrompt('fox in snow', { kind: 'image' })
    expect(out).toEqual({ status: 'improved', prompt: 'A red fox in deep snow.' })
    expect(calls.list).toHaveLength(1)
    expect(calls.list[0].model).toBe('chat-model')
    expect(calls.list[0].messages[1].content).toBe('fox in snow')
  })

  it('bucht seinen Platz auf der Spur des Chatmodells, lokal wie in der Cloud', async () => {
    await improvePrompt('x', { kind: 'video' })
    plan.lane = 'local'
    plan.provider = 'ollama'
    useModelStore.setState({ activeModel: 'qwen3:8b' })
    await improvePrompt('x', { kind: 'video' })
    expect(calls.lanes.map((l) => l.lane)).toEqual(['cloud', 'local'])
    expect(new Set(calls.lanes.map((l) => l.id))).toEqual(new Set(['create::improve-prompt']))
  })

  it('names no window of its own, so a local model is sent the one it is loaded with', async () => {
    // The provider resolves the window (api/ollama.ts); a call that names
    // none can never be the reason Ollama loads the model again.
    await improvePrompt('x', { kind: 'image' })
    expect(calls.list[0].opts).not.toHaveProperty('window')
    expect(calls.list[0].opts).not.toHaveProperty('contextWindow')
  })

  it('schaltet das Denken aus, wo das Modell es kann, sonst nur die kleinste Stufe', async () => {
    await improvePrompt('x', { kind: 'image' })
    expect(calls.list[0].opts.thinking).toBe(false)
    expect(calls.list[0].opts.reasoningEffort).toBe('low')
    plan.thinkCompatible = false
    await improvePrompt('x', { kind: 'image' })
    expect(calls.list[1].opts.thinking).toBeUndefined()
    useModelStore.setState({ models: [{ name: 'lu-cloud::chat-model', thinkMode: 'always' } as never] })
    plan.thinkCompatible = true
    await improvePrompt('x', { kind: 'image' })
    expect(calls.list[2].opts.thinking).toBeUndefined()
  })

  it('ein Fehler des Aufrufs wirft nicht, er heisst failed', async () => {
    plan.throws = new Error('402 credits')
    expect(await improvePrompt('x', { kind: 'video' })).toEqual({ status: 'failed' })
  })

  it('eine Absage, eine leere Antwort oder eine ausgereihte Spur heisst failed', async () => {
    plan.chunks = ["I'm sorry, I can't do that."]
    expect(await improvePrompt('x', { kind: 'image' })).toEqual({ status: 'failed' })
    plan.chunks = []
    expect(await improvePrompt('x', { kind: 'image' })).toEqual({ status: 'failed' })
    plan.chunks = ['fine']
    plan.queued = true
    expect(await improvePrompt('x', { kind: 'image' })).toEqual({ status: 'failed' })
  })

  it('kommt derselbe Text zurueck, ist nichts umgeschrieben', async () => {
    plan.chunks = ['same words']
    expect(await improvePrompt('same words', { kind: 'music' })).toEqual({ status: 'unchanged' })
  })

  it('ein Abbruch von aussen bricht den Aufruf ab', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await improvePrompt('x', { kind: 'image' }, ac.signal)).toEqual({ status: 'failed' })
    expect(calls.list).toHaveLength(0)
  })

  it('ohne Chatmodell geht gar kein Aufruf hinaus', async () => {
    useModelStore.setState({ activeModel: null })
    expect(await improvePrompt('x', { kind: 'image' })).toEqual({ status: 'failed' })
    expect(calls.list).toHaveLength(0)
  })
})

describe('Improve my prompt: Verfuegbarkeit (Desktop)', () => {
  it('ohne Chatmodell steht der Grund im Schalter', () => {
    const a = improveAvailabilityFor(null)
    expect(a.available).toBe(false)
    expect(a.hint).toMatch(/chat model/i)
  })

  it('LU Cloud: wie eine kurze Chatnachricht gebucht', () => {
    const a = improveAvailabilityFor('lu-cloud::chat-model')
    expect(a.available).toBe(true)
    expect(a.hint).toMatch(/billed like a short chat message/i)
  })

  it('lokal: laeuft auf dem eigenen Rechner und wird nicht gebucht', () => {
    plan.provider = 'ollama'
    const a = improveAvailabilityFor('qwen3:8b')
    expect(a.available).toBe(true)
    expect(a.hint).toMatch(/your machine/i)
    expect(a.hint).not.toMatch(/billed/i)
  })
})

/**
 * 3.0.5: in Cloud mode the app picks no chat model by itself any more, so a
 * new account can have the switch on and no chat model. The rewrite then runs
 * on the fixed helper model instead of being a dead end. Local mode is as it
 * was: no chat model, no rewrite.
 */
describe('Improve my prompt without a picked chat model', () => {
  const cloudMode = () => useSettingsStore.setState((st) => ({ settings: { ...st.settings, appMode: 'cloud' } }))

  it('the helper model is written down once, with the id the web app uses', () => {
    expect(CLOUD_HELPER_MODEL).toBe('lu-cloud::mistralai/Mistral-Small-3.2-24B-Instruct-2506')
  })

  it('helperModelFor: the pick wins, Cloud falls back to the helper, Local to nothing', () => {
    expect(helperModelFor('lu-cloud::chat-model', 'cloud')).toBe('lu-cloud::chat-model')
    expect(helperModelFor('qwen3:8b', 'local')).toBe('qwen3:8b')
    expect(helperModelFor(null, 'cloud')).toBe(CLOUD_HELPER_MODEL)
    expect(helperModelFor(null, 'local')).toBeNull()
    expect(helperModelFor(null, undefined)).toBeNull()
  })

  it('Cloud: the switch is usable and says who writes and what it costs', () => {
    const a = improveAvailabilityFor(null, 'cloud')
    expect(a.available).toBe(true)
    expect(a.hint).toBe('A small LU Cloud model rewrites your prompt for the model you picked. Billed like a short chat message.')
  })

  it('NEGATIVE CONTROL, Local: still needs a chat model', () => {
    const a = improveAvailabilityFor(null, 'local')
    expect(a.available).toBe(false)
    expect(a.hint).toMatch(/chat model/i)
  })

  it('THE FIX, Cloud: the rewrite runs on the helper model', async () => {
    useModelStore.setState({ activeModel: null, models: [] })
    cloudMode()
    const out = await improvePrompt('a fox', { kind: 'image', modelLabel: 'Qwen Image 2.1' })
    expect(out).toEqual({ status: 'improved', prompt: 'A red fox in deep snow.' })
    expect(calls.list).toHaveLength(1)
    expect(calls.list[0].model).toBe('mistralai/Mistral-Small-3.2-24B-Instruct-2506')
  })

  it('Cloud with a pick: the picked chat model writes, not the helper', async () => {
    cloudMode()
    await improvePrompt('a fox', { kind: 'image', modelLabel: 'Qwen Image 2.1' })
    expect(calls.list[0].model).toBe('chat-model')
  })

  it('NEGATIVE CONTROL, Local without a chat model: nothing is called', async () => {
    useModelStore.setState({ activeModel: null, models: [] })
    const out = await improvePrompt('a fox', { kind: 'image', modelLabel: 'Qwen Image 2.1' })
    expect(out).toEqual({ status: 'failed' })
    expect(calls.list).toHaveLength(0)
  })
})
