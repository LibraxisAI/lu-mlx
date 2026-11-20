import { beforeEach, describe, expect, it, vi } from 'vitest'

const strategy = vi.hoisted(() => ({ value: { strategy: 'native', modelToUse: 'model', modelId: 'model', providerId: 'openai' } as Record<string, unknown> }))
const cloud = vi.hoisted(() => ({ token: 'supabase-session-token' as string | null, fail: false }))
const engine = vi.hoisted(() => ({ alive: vi.fn(async (_model: string) => {}), ctx: vi.fn(async (_model: string) => {}) }))

vi.mock('../../lib/agent-strategy', () => ({ resolveToolCallingStrategy: vi.fn(async () => strategy.value) }))
vi.mock('../cloud/supabase', () => ({
  getAccessToken: vi.fn(async () => {
    if (cloud.fail) throw new Error('LU Cloud unreachable. Check your connection.')
    return cloud.token
  }),
}))
vi.mock('../builtin-ensure', () => ({ ensureBuiltinEngineAlive: engine.alive, ensureBuiltinAgentCtx: engine.ctx }))
// The one source of an Ollama window (proven on the wire in
// one-window-per-ollama-model.test.ts). Here it only has to be asked.
const ollamaWindow = vi.hoisted(() => vi.fn(async (_model: string, _use?: string) => 16384))
vi.mock('../ollama', () => ({ ollamaNumCtx: ollamaWindow }))

import { CLOUD_BASE } from '../cloud/config'
import { useModelStore } from '../../stores/modelStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { VoiceBrainError, describeVoiceBrain, resolveVoiceBrain, takesTheEngineFrom, voiceThinkingExtra, voiceThinkingLock, voiceThinkingOnExtra, voiceThinkingPlan } from '../voice-brain'

const KEY = 'sk-test-0123456789abcdef'

function provider(id: 'ollama' | 'openai' | 'anthropic' | 'lu-cloud', patch: Record<string, unknown>) {
  useProviderStore.setState((state) => ({ providers: { ...state.providers, [id]: { ...state.providers[id], ...patch } } }))
}

function resolves(providerId: string, model: string, strategyName = 'native') {
  strategy.value = { strategy: strategyName, modelToUse: model, modelId: model, providerId }
}

beforeEach(() => {
  cloud.token = 'supabase-session-token'
  cloud.fail = false
  engine.alive.mockClear()
  engine.ctx.mockClear()
  useProviderStore.getState().resetProvidersToDefaults?.()
  useModelStore.setState({ models: [] })
})

describe('resolveVoiceBrain', () => {
  it('asks for a model when none is selected', async () => {
    await expect(resolveVoiceBrain(null)).rejects.toMatchObject({ kind: 'no-model' })
    await expect(resolveVoiceBrain('')).rejects.toBeInstanceOf(VoiceBrainError)
  })

  it('wakes the LU Engine on the model and reads its address afterwards', async () => {
    provider('openai', { baseUrl: 'http://127.0.0.1:8127/v1', managed: true, isLocal: true, apiKey: '' })
    resolves('openai', 'qwen-9b')
    // The engine may come back on another port. The brain must carry that one.
    engine.alive.mockImplementationOnce(async () => { provider('openai', { baseUrl: 'http://127.0.0.1:8131/v1/' }) })
    const brain = await resolveVoiceBrain('openai::qwen-9b')
    expect(engine.alive).toHaveBeenCalledWith('qwen-9b')
    expect(engine.ctx).toHaveBeenCalledWith('qwen-9b')
    expect(brain.llm).toMatchObject({ base_url: 'http://127.0.0.1:8131/v1', model: 'qwen-9b' })
    expect(brain.llm.api_key).toBeUndefined()
    expect(brain).toMatchObject({ providerId: 'openai', toolsSupported: true, modelLabel: 'qwen-9b' })
  })

  it('can put the model back on the LU Engine after a screen model used it, and knows when that is needed', async () => {
    provider('openai', { baseUrl: 'http://127.0.0.1:8127/v1', managed: true, isLocal: true, apiKey: '' })
    resolves('openai', 'qwen-9b')
    const brain = await resolveVoiceBrain('openai::qwen-9b')
    // The engine holds one model: another model on it takes it away, the same one does not.
    expect(takesTheEngineFrom(brain, 'openai::Holo-3.1-9B')).toBe(true)
    expect(takesTheEngineFrom(brain, 'openai::qwen-9b')).toBe(false)
    expect(takesTheEngineFrom(brain, 'lu-cloud::some-model')).toBe(false)
    expect(takesTheEngineFrom(brain, 'llava:13b')).toBe(false)
    engine.alive.mockClear()
    engine.ctx.mockClear()
    await brain.restore!()
    expect(engine.alive).toHaveBeenCalledWith('qwen-9b')
    expect(engine.ctx).toHaveBeenCalledWith('qwen-9b')
  })

  it('has nothing to put back for a server the app does not manage', async () => {
    provider('openai', { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', managed: false, isLocal: true })
    resolves('openai', 'local-model')
    const brain = await resolveVoiceBrain('openai::local-model')
    expect(brain.restore).toBeUndefined()
    expect(takesTheEngineFrom(brain, 'openai::Holo-3.1-9B')).toBe(false)
  })

  it('reports an engine that does not start as a model error with its own sentence', async () => {
    provider('openai', { managed: true })
    resolves('openai', 'qwen-9b')
    engine.alive.mockRejectedValueOnce(new Error('The LU Engine could not load this model.'))
    await expect(resolveVoiceBrain('openai::qwen-9b')).rejects.toMatchObject({ kind: 'model-error', message: 'The LU Engine could not load this model.' })
  })

  it('does not wake anything for LM Studio or another server in the same slot', async () => {
    provider('openai', { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', managed: false, isLocal: true })
    resolves('openai', 'local-model')
    const brain = await resolveVoiceBrain('openai::local-model')
    expect(engine.alive).not.toHaveBeenCalled()
    expect(brain.llm.base_url).toBe('http://localhost:1234/v1')
  })

  it('uses the OpenAI-compatible endpoint of Ollama', async () => {
    provider('ollama', { baseUrl: 'http://localhost:11434/', enabled: true })
    resolves('ollama', 'qwen3.5:9b-agent')
    const brain = await resolveVoiceBrain('qwen3.5:9b')
    expect(brain.llm.base_url).toBe('http://localhost:11434/v1')
    // The agent variant the strategy picked, not the picker name.
    expect(brain.llm.model).toBe('qwen3.5:9b-agent')
    expect(brain.llm.api_key).toBeUndefined()
  })

  it('gives the voice loop the chat window of an Ollama model, and of no other', async () => {
    provider('ollama', { enabled: true })
    resolves('ollama', 'qwen3:8b')
    ollamaWindow.mockClear()
    const onOllama = await resolveVoiceBrain('qwen3:8b')
    // Asked as a chat: a voice session and a chat share one loaded model.
    expect(ollamaWindow).toHaveBeenCalledWith('qwen3:8b', 'chat')
    expect(onOllama.llm.ollama_num_ctx).toBe(16384)

    ollamaWindow.mockClear()
    provider('openai', { baseUrl: 'http://127.0.0.1:1234/v1', managed: false, isLocal: true, apiKey: '' })
    resolves('openai', 'some-model')
    const elsewhere = await resolveVoiceBrain('openai::some-model')
    expect(ollamaWindow).not.toHaveBeenCalled()
    expect(elsewhere.llm).not.toHaveProperty('ollama_num_ctx')
    cloud.token = 'supabase-session-token'
    resolves('lu-cloud', 'Qwen/Some-Model')
    expect((await resolveVoiceBrain('lu-cloud::Qwen/Some-Model')).llm).not.toHaveProperty('ollama_num_ctx')
  })

  it('hands the key of an own OpenAI-compatible endpoint to the session, decoded', async () => {
    provider('openai', { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', managed: false, isLocal: false })
    useProviderStore.getState().setProviderApiKey('openai', KEY)
    resolves('openai', 'vendor/model')
    const brain = await resolveVoiceBrain('openai::vendor/model')
    expect(brain.llm).toMatchObject({ base_url: 'https://openrouter.ai/api/v1', model: 'vendor/model', api_key: KEY })
  })

  it('uses the session token for LU Cloud and pins the address, whatever the store says', async () => {
    provider('lu-cloud', { baseUrl: 'https://evil.example/v1', enabled: true })
    resolves('lu-cloud', 'zai-org/GLM-5.3')
    const brain = await resolveVoiceBrain('lu-cloud::zai-org/GLM-5.3')
    expect(brain.llm).toMatchObject({ base_url: `${CLOUD_BASE}/api/inference/v1`, api_key: 'supabase-session-token', model: 'zai-org/GLM-5.3' })
    expect(JSON.stringify(brain)).not.toContain('evil.example')
  })

  it('asks to sign in when there is no cloud session, and says so when the cloud is unreachable', async () => {
    resolves('lu-cloud', 'm')
    cloud.token = null
    await expect(resolveVoiceBrain('lu-cloud::m')).rejects.toMatchObject({ kind: 'signed-out' })
    cloud.fail = true
    await expect(resolveVoiceBrain('lu-cloud::m')).rejects.toMatchObject({ kind: 'model-error', message: 'LU Cloud unreachable. Check your connection.' })
  })

  it('refuses a provider without an OpenAI-compatible endpoint', async () => {
    resolves('anthropic', 'claude')
    await expect(resolveVoiceBrain('anthropic::claude')).rejects.toMatchObject({ kind: 'unsupported-model' })
  })

  it('refuses an address that is not http or https', async () => {
    provider('openai', { baseUrl: 'file:///etc/passwd', managed: false })
    resolves('openai', 'm')
    await expect(resolveVoiceBrain('openai::m')).rejects.toMatchObject({ kind: 'model-error' })
  })

  it('offers no tools to a model that cannot take them natively', async () => {
    provider('ollama', { enabled: true })
    resolves('ollama', 'smollm2:360m', 'hermes_xml')
    expect((await resolveVoiceBrain('smollm2:360m')).toolsSupported).toBe(false)
  })

  it('passes a changed temperature and nothing else from the sampling settings', async () => {
    provider('ollama', { enabled: true })
    resolves('ollama', 'm')
    const before = useSettingsStore.getState().settings.temperature
    try {
      useSettingsStore.getState().updateSettings({ temperature: 0.2 })
      const brain = await resolveVoiceBrain('m')
      expect(brain.llm.temperature).toBe(0.2)
      // `extra` is the thinking switch, not a sampling setting.
      // `ollama_num_ctx` is the window, which Voice shares with Chat.
      expect(Object.keys(brain.llm).sort()).toEqual(['base_url', 'extra', 'model', 'ollama_num_ctx', 'temperature'])
      expect(brain.llm.extra).toEqual({ reasoning_effort: 'none' })
    } finally {
      useSettingsStore.getState().updateSettings({ temperature: before })
    }
  })
})

describe('the key stays out of stores and logs', () => {
  it('writes neither a provider key nor the cloud token into the voice stores or a log line', async () => {
    const { useVoiceSessionStore } = await import('../../stores/voiceSessionStore')
    const { useVoiceStore } = await import('../../stores/voiceStore')
    const logged: unknown[] = []
    const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args) }))
    try {
      provider('openai', { name: 'Own', baseUrl: 'https://llm.example.com/v1', managed: false, isLocal: false })
      useProviderStore.getState().setProviderApiKey('openai', KEY)
      resolves('openai', 'm')
      const own = await resolveVoiceBrain('openai::m')
      resolves('lu-cloud', 'm')
      const hosted = await resolveVoiceBrain('lu-cloud::m')
      useVoiceSessionStore.getState().dispatch({ type: 'start', at: 1, muted: false })
      useVoiceSessionStore.getState().dispatch({ type: 'brain', modelLabel: own.modelLabel, notice: null })

      const everything = JSON.stringify([
        useVoiceSessionStore.getState(), useVoiceStore.getState(), describeVoiceBrain(own), describeVoiceBrain(hosted), logged,
      ])
      expect(everything).not.toContain(KEY)
      expect(everything).not.toContain('supabase-session-token')
      expect(describeVoiceBrain(own)).toEqual({ providerId: 'openai', model: 'm', host: 'llm.example.com', hasKey: true, tools: true, local: false })
    } finally {
      spies.forEach((spy) => spy.mockRestore())
      useVoiceSessionStore.getState().dispatch({ type: 'stopping' })
      useVoiceSessionStore.getState().dispatch({ type: 'stopped' })
    }
  })

  it('persists the choices of the voice surface and nothing secret', async () => {
    const { useVoiceStore } = await import('../../stores/voiceStore')
    // The start sound is on until the user switches it off.
    expect(useVoiceStore.getState().loopStartSound).toBe(true)
    const partialize = useVoiceStore.persist.getOptions().partialize!
    const kept = partialize({ ...useVoiceStore.getState(), micId: 'mic-1', micLabel: 'Desk microphone', loopStartMuted: true, loopStartSound: false }) as Record<string, unknown>
    expect(kept.micId).toBe('mic-1')
    expect(kept.micLabel).toBe('Desk microphone')
    expect(kept.loopStartMuted).toBe(true)
    expect(kept.loopStartSound).toBe(false)
    expect(Object.keys(kept).filter((key) => key.startsWith('loop')).sort()).toEqual([
      'loopAgent', 'loopComputerConfirmed', 'loopScope', 'loopStartMuted', 'loopStartSound',
      'loopThinking', 'loopThinkingBudget', 'loopWorkspace',
    ])
    // A fresh installation starts narrow: tools in the folder only, no thinking.
    expect(kept.loopScope).toBe('workspace')
    expect(kept.loopComputerConfirmed).toBe(false)
    expect(kept.loopThinking).toBe(false)
    expect(Object.keys(kept).filter((key) => /token|key|secret|session/i.test(key))).toEqual([])
  })
})

describe('voiceThinkingExtra', () => {
  const base = { providerId: 'openai', local: true, reasons: false } as const

  it('sends nothing for a model that does not reason', () => {
    expect(voiceThinkingExtra(base)).toEqual({})
    expect(voiceThinkingExtra({ ...base, thinkMode: 'never', reasons: true })).toEqual({})
  })

  it('switches thinking off on Ollama and LU Cloud with the off switch of the API', () => {
    expect(voiceThinkingExtra({ providerId: 'ollama', local: true, reasons: true })).toEqual({ reasoning_effort: 'none' })
    expect(voiceThinkingExtra({ providerId: 'lu-cloud', local: false, thinkMode: 'toggle', reasons: false })).toEqual({ reasoning_effort: 'none' })
  })

  it('also sets the template switch on a local OpenAI-compatible server', () => {
    expect(voiceThinkingExtra({ ...base, reasons: true })).toEqual({
      reasoning_effort: 'none', extra_body: { chat_template_kwargs: { enable_thinking: false } },
    })
  })

  it('asks a model that always reasons for its cheapest rung, never for none', () => {
    expect(voiceThinkingExtra({ providerId: 'lu-cloud', local: false, thinkMode: 'always', effortLevels: ['low', 'medium', 'high', 'max'], reasons: true }))
      .toEqual({ reasoning_effort: 'low' })
    expect(voiceThinkingExtra({ providerId: 'lu-cloud', local: false, thinkMode: 'always', effortLevels: ['medium', 'high'], reasons: true }))
      .toEqual({ reasoning_effort: 'medium' })
    expect(voiceThinkingExtra({ providerId: 'lu-cloud', local: false, thinkMode: 'always', reasons: true })).toEqual({})
  })

  it('sends an unknown remote endpoint only a rung it declared', () => {
    expect(voiceThinkingExtra({ providerId: 'openai', local: false, reasons: true })).toEqual({})
    expect(voiceThinkingExtra({ providerId: 'openai', local: false, reasons: true, effortLevels: ['low', 'high'] })).toEqual({ reasoning_effort: 'low' })
  })
})

describe('voiceThinkingPlan', () => {
  it('keeps the off switch ready for the second try while thinking is on', () => {
    const local = { providerId: 'openai', local: true, reasons: true } as const
    const on = voiceThinkingPlan(local, true)
    expect(on.wanted).toBe(true)
    expect(on.extra).toEqual({ extra_body: { chat_template_kwargs: { enable_thinking: true } } })
    expect(on.directExtra).toEqual({ reasoning_effort: 'none', extra_body: { chat_template_kwargs: { enable_thinking: false } } })
    const off = voiceThinkingPlan(local, false)
    expect(off.wanted).toBe(false)
    expect(off.extra).toEqual(off.directExtra)
  })

  it('never cuts and never shows the thought of a model that always thinks, whatever the switch says', () => {
    const always = { providerId: 'lu-cloud', local: false, thinkMode: 'always', effortLevels: ['low', 'medium', 'high'], reasons: true } as const
    for (const wanted of [true, false]) {
      expect(voiceThinkingPlan(always, wanted)).toEqual({
        extra: { reasoning_effort: 'low' }, directExtra: { reasoning_effort: 'low' }, wanted: false, always: true,
      })
    }
    expect(voiceThinkingPlan({ providerId: 'ollama', local: true, reasons: true }, true).always).toBe(false)
  })

  it('asks a model with rungs for its cheapest one when thinking is on', () => {
    expect(voiceThinkingOnExtra({ providerId: 'lu-cloud', local: false, thinkMode: 'toggle', effortLevels: ['low', 'medium', 'high'], reasons: true }))
      .toEqual({ reasoning_effort: 'low' })
    expect(voiceThinkingOnExtra({ providerId: 'ollama', local: true, reasons: true })).toEqual({})
    expect(voiceThinkingOnExtra({ providerId: 'ollama', local: true, thinkMode: 'never', reasons: false })).toEqual({})
  })

  it('always sends Ollama the off switch: a build that reports no thinking can still think (Qwen3 4B, 08.10.2026)', () => {
    expect(voiceThinkingExtra({ providerId: 'ollama', local: true, reasons: false })).toEqual({ reasoning_effort: 'none' })
  })

  it('locks the switch only for a model that declares it always or never thinks', () => {
    expect(voiceThinkingLock({ thinkMode: 'always', reasons: true })).toBe('always')
    expect(voiceThinkingLock({ thinkMode: 'never', reasons: false })).toBe('never')
    expect(voiceThinkingLock({ thinkMode: 'toggle', reasons: true })).toBeNull()
    expect(voiceThinkingLock({ reasons: true })).toBeNull()
  })
})
