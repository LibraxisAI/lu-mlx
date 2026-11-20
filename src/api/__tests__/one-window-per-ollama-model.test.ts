/**
 * @vitest-environment jsdom
 *
 * One Ollama model, one window, whoever asks.
 *
 * Ollama keeps a model loaded for exactly one num_ctx and loads it again for
 * a request that names another one. So what has to be proven is not a
 * function's return value but what leaves the app: every request body to
 * /api/chat and /api/generate is captured here, behind the REAL provider and
 * the REAL callers, and the num_ctx in them is compared.
 *
 * The rule (lib/context-window.ts, api/ollama.ts):
 *   - a turn a person started names its use: `chat` or `agent`;
 *   - everything else names nothing and is sent what the model was last sent;
 *   - the user's own setting wins over both.
 *
 * Run: npx vitest run src/api/__tests__/one-window-per-ollama-model.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Sent { path: string; model: string; numCtx: number | undefined }
const sent: Sent[] = []
/** /api/show: a model trained on 131072 tokens, which is most of what people run. */
const SHOW = { model_info: { 'general.context_length': 131072 }, capabilities: ['completion', 'tools'] }

function answer(url: string, init?: { body?: unknown }): Response {
  const path = url.slice(url.indexOf('/api/') + 4)
  if (path === '/show') return new Response(JSON.stringify(SHOW), { status: 200 })
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string; options?: { num_ctx?: number }; stream?: boolean } : {}
  if (path === '/chat' || path === '/generate') {
    sent.push({ path, model: body.model ?? '', numCtx: body.options?.num_ctx })
  }
  const line = { model: body.model, message: { role: 'assistant', content: '{"shouldSave": false, "memories": []}' }, done: true, done_reason: 'stop' }
  return new Response(JSON.stringify(line) + '\n', { status: 200 })
}

vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return {
    ...actual,
    isTauri: () => false,
    localFetch: vi.fn(async (url: string, init?: { body?: unknown }) => answer(url, init)),
    localFetchStream: vi.fn(async (url: string, init?: { body?: unknown }) => answer(url, init)),
    ollamaUrl: (p: string) => `http://localhost:11434/api${p.startsWith('/') ? p : '/' + p}`,
  }
})
// A Create render never moved the chat model out in these tests.
vi.mock('../../lib/chat-backends-gate', () => ({ chatBackendsBack: async () => {}, setChatBackendsRestore: () => {} }))

import { getProviderForModel } from '../providers'
import { forgetSentWindows, loadModel, ollamaNumCtx, reloadOllamaWithWindow } from '../ollama'
import { streamOllamaChatWithTools } from '../../lib/ollama-stream-tools'
import { resolveVoiceBrain } from '../voice-brain'
import { planWithArchitect } from '../agents/architect'
import { askExecutor, checkGoalReached } from '../computer-executor'
import { runCompactSummary } from '../../lib/compact-run'
import { improvePrompt } from '../../lib/render/improve-prompt-run'
import { extractMemoriesFromPair } from '../../hooks/useMemory'
import { resolveAgentNumCtx } from '../../lib/agent-num-ctx'
import { AGENT_CONTEXT_CAP, DEFAULT_CONTEXT_CAP } from '../../lib/context-window'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { useMemoryStore } from '../../stores/memoryStore'
import { __resetRunLanesForTests } from '../../lib/run-lanes'
import type { ChatMessage, ChatOptions } from '../providers/types'

const MODEL = 'qwen3:8b'
const HELLO: ChatMessage[] = [{ role: 'user', content: 'Hello' }]
/** Long enough that a summary of it can be smaller than it is. */
const LONG_HISTORY = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i}: ` + 'content '.repeat(60) }))

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of stream) void chunk
}
/** A turn a person started, through the provider as the hooks call it. */
async function visibleTurn(window: ChatOptions['window']): Promise<void> {
  const { provider, modelId } = getProviderForModel(MODEL)
  await drain(provider.chatStream(modelId, HELLO, { window }))
}
const windows = () => sent.filter((s) => s.model === MODEL).map((s) => s.numCtx)

/**
 * Every call nobody sees that this app makes on the chat model. Each entry
 * runs the REAL caller. A new silent caller belongs in this list; the guard
 * in lib/__tests__/ollama-window-guard.test.ts is what catches one that
 * bypasses the provider instead.
 */
const SILENT_CALLS: Record<string, () => Promise<unknown>> = {
  'memory extraction': () => extractMemoriesFromPair('I am a baker', 'x'.repeat(200), 'conv-1', { digest: true }),
  'context compaction': () => runCompactSummary({ turns: LONG_HISTORY, activeModel: MODEL }),
  'prompt rewrite': () => improvePrompt('a cat', { kind: 'image' }),
  'architect plan': () => planWithArchitect({ model: MODEL, userInstruction: 'Plan it', workingDirectory: '/work' }),
  'screen model step': () => askExecutor({ model: MODEL, label: MODEL, format: 'generic', sees: false }, HELLO),
  'screen model goal check': () => checkGoalReached({ model: MODEL, label: MODEL, format: 'generic', sees: false }, { goal: 'g', actions: [], screen: 's', frame: null }),
  'sub-agent and benchmark shape (provider call without options)': async () => {
    const { provider, modelId } = getProviderForModel(MODEL)
    await provider.chatWithTools(modelId, HELLO, [], {})
    await drain(provider.chatStream(modelId, HELLO, { temperature: 0.7 }))
  },
  'tool stream without a window': () => {
    const { modelId } = getProviderForModel(MODEL)
    return streamOllamaChatWithTools(modelId, HELLO, [], {}, () => {}, () => {})
  },
  'load switch': () => loadModel(MODEL),
}

beforeEach(() => {
  sent.length = 0
  forgetSentWindows()
  __resetRunLanesForTests()
  useSettingsStore.getState().updateSettings({ contextWindowOverride: 0, appMode: 'local' })
  useModelStore.setState({ activeModel: MODEL, models: [] })
  useMemoryStore.setState((state) => ({ settings: { ...state.settings, autoExtractEnabled: true } }))
})

describe('the two windows', () => {
  it('a chat turn sends the chat window, an agent turn the agent window', async () => {
    await visibleTurn('chat')
    await visibleTurn('agent')
    expect(windows()).toEqual([DEFAULT_CONTEXT_CAP, AGENT_CONTEXT_CAP])
  })

  it('the budget of an agent run is the number the request carries', async () => {
    await visibleTurn('agent')
    expect(await resolveAgentNumCtx(MODEL, 'ollama', 0, MODEL)).toBe(windows()[0])
  })

  it("the user's own setting wins over both, for every caller", async () => {
    useSettingsStore.getState().updateSettings({ contextWindowOverride: 65536 })
    await visibleTurn('chat')
    await visibleTurn('agent')
    await visibleTurn(undefined)
    await loadModel(MODEL)
    expect(new Set(windows())).toEqual(new Set([65536]))
  })

  it('a call that follows a turn the app did not send carries no window and changes nothing', async () => {
    await visibleTurn('agent')
    await visibleTurn('backend-default')
    await visibleTurn(undefined)
    expect(windows()).toEqual([AGENT_CONTEXT_CAP, undefined, AGENT_CONTEXT_CAP])
  })
})

describe.each([
  ['chat', DEFAULT_CONTEXT_CAP],
  ['agent', AGENT_CONTEXT_CAP],
] as const)('after a %s turn', (use, window) => {
  it.each(Object.keys(SILENT_CALLS))('%s sends the same window', async (name) => {
    await visibleTurn(use)
    const before = sent.length
    await SILENT_CALLS[name]()
    const after = sent.slice(before).filter((s) => s.model === MODEL)
    // The call really reached Ollama, and with nothing but the loaded window.
    expect(after.length, `${name} sent no request`).toBeGreaterThan(0)
    expect(after.map((s) => s.numCtx)).toEqual(after.map(() => window))
  })
})

describe('a model nothing was sent to yet', () => {
  it.each(Object.keys(SILENT_CALLS))('%s sends the chat window', async (name) => {
    await SILENT_CALLS[name]()
    const all = sent.filter((s) => s.model === MODEL)
    expect(all.length, `${name} sent no request`).toBeGreaterThan(0)
    expect(new Set(all.map((s) => s.numCtx))).toEqual(new Set([DEFAULT_CONTEXT_CAP]))
  })
})

describe('Voice', () => {
  it('hands the voice loop the window the chat sends for this model', async () => {
    await visibleTurn('chat')
    const brain = await resolveVoiceBrain(MODEL)
    expect(brain.providerId).toBe('ollama')
    expect(brain.llm.ollama_num_ctx).toBe(windows()[0])
    expect(brain.llm.ollama_num_ctx).toBe(DEFAULT_CONTEXT_CAP)
  })

  it('and the digest of the session, and the chat after it, send that window again', async () => {
    const brain = await resolveVoiceBrain(MODEL)
    await SILENT_CALLS['memory extraction']()
    await visibleTurn('chat')
    expect(new Set([brain.llm.ollama_num_ctx, ...windows()])).toEqual(new Set([DEFAULT_CONTEXT_CAP]))
  })

  it('a voice session after an agent run is a chat again, and what follows it follows it', async () => {
    await visibleTurn('agent')
    const brain = await resolveVoiceBrain(MODEL)
    expect(brain.llm.ollama_num_ctx).toBe(DEFAULT_CONTEXT_CAP)
    await SILENT_CALLS['memory extraction']()
    expect(windows().slice(1)).toEqual([DEFAULT_CONTEXT_CAP])
  })

  it('gives no window for a model that is not on Ollama', async () => {
    expect(await ollamaNumCtx(MODEL, 'chat')).toBe(DEFAULT_CONTEXT_CAP)
    // The field exists only on the Ollama branch of resolveVoiceBrain; the
    // voice loop's own tests cover what it does with and without it.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve(__dirname, '../voice-brain.ts'), 'utf8')
    expect(source.match(/ollamaNumCtxForVoice = /g)).toHaveLength(1)
    expect(source).toMatch(/providerId === 'ollama'\) \{[\s\S]{0,600}ollamaNumCtxForVoice = await ollamaNumCtx\(modelToUse, 'chat'\)/)
  })
})

describe('changing the window in the header', () => {
  it('loads the model with the window of the surface it was changed on', async () => {
    await reloadOllamaWithWindow(MODEL, 'agent')
    await visibleTurn('agent')
    expect(sent.map((s) => [s.path, s.numCtx])).toEqual([['/generate', AGENT_CONTEXT_CAP], ['/chat', AGENT_CONTEXT_CAP]])
  })
})
