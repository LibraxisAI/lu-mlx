import { readFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { LIVE, LIVE_READY, fakeMicInit, spokenQuestion, spokenScript, startSidecar, type LiveSidecar } from './support/voice-live'
import { appModules, type AppWindow } from './support/ui'

/**
 * A model that thinks, against the REAL voice loop and a real local model.
 *
 * 08.10.2026: "The answer is not read aloud, because the model does
 * not get out of its thinking", and the transcript showed "(Think)" and the
 * raw thought. His session ran a Qwen3 4B build on Ollama that reports no
 * thinking capability and writes its thought into the answer between
 * <think> tags. Run this spec with that model to see his case:
 *
 *   LU_E2E_CSP=1 LU_E2E_PORT=5282 \
 *   LU_VOICE_PYTHON=<venv>/bin/python LU_VOICE_MODELS_DIR=<models> \
 *   LU_VOICE_LLM_MODEL=hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M \
 *   npx playwright test e2e/voice-thinking-live.spec.ts [--project=webkit]
 *
 * The agent is off in every test here, as it was for him: that build takes
 * no tools. LU_VOICE_TURNS=<n> adds a talk of n questions, used to measure
 * the memory of the voice engine over a longer session.
 */

const SHOTS = process.env.LU_VOICE_SHOTS
const TURNS = Number(process.env.LU_VOICE_TURNS) || 0
const QUESTION = 'Why is the sky blue?'
const wav = LIVE_READY ? spokenQuestion(QUESTION, 15) : ''
const QUESTIONS = [
  'What is the capital of France?', 'How many days does a week have?', 'What color is grass?', 'What is two plus two?',
  'Name one planet.', 'What do bees make?', 'Is ice cold or hot?', 'What is the opposite of up?',
  'How many legs does a cat have?', 'What comes after Monday?', 'What do you drink when you are thirsty?', 'Which animal says meow?',
]
const talk = LIVE_READY && TURNS > 0
  ? spokenScript(QUESTIONS.slice(0, TURNS).map((text) => ({ text, pauseSecs: 14 })), 15)
  : null
const audio = process.env.LU_VOICE_LONG === '1' && talk ? talk.file : wav

test.skip(!LIVE_READY, 'Needs LU_VOICE_PYTHON, LU_VOICE_MODELS_DIR and LU_VOICE_LLM_MODEL (a real voice loop and a local model).')
test.describe.configure({ mode: 'serial' })
test.setTimeout(600_000)

test.use({
  launchOptions: async ({ browserName }, apply) => {
    await apply(browserName === 'chromium'
      ? { args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audio}%noloop`] }
      : {})
  },
})

let sidecar: LiveSidecar

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  sidecar = await startSidecar(new URL(testInfo.project.use.baseURL ?? 'http://localhost:5273').origin)
})
test.afterAll(async () => { expect(await sidecar?.stop()).toBe(0) })

interface Probe { playedSeconds: number }

function probeInit() {
  const probe: Probe = { playedSeconds: 0 }
  ;(window as unknown as { __voiceProbe: Probe }).__voiceProbe = probe
  const start = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...args: [number?, number?, number?]) {
    probe.playedSeconds += this.buffer?.duration ?? 0
    return start.apply(this, args)
  }
}

async function boot(page: Page, browserName: string, opts: { thinking: boolean; budget?: number }) {
  const sessionRequests: Array<{ active_tools?: string[]; thinking?: { wanted?: boolean; budget_tokens?: number } }> = []
  page.on('request', (request) => {
    if (request.url().endsWith('/session') && request.method() === 'POST') sessionRequests.push(JSON.parse(request.postData() ?? '{}'))
  })
  await page.addInitScript(probeInit)
  if (browserName !== 'chromium') await page.addInitScript(fakeMicInit, readFileSync(audio).toString('base64'))
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: 'unused-engine-model',
    platform: 'mac' as const,
    ollamaModels: [LIVE.llmModel],
    voiceLoop: { installed: true, running: true, session: { port: sidecar.port, token: sidecar.token } },
  })
  await seedOnboardingDone(page)
  await page.addInitScript(([model, thinking, budget]: [string, boolean, number]) => {
    const settings = JSON.parse(localStorage.getItem('chat-settings')!)
    settings.state.settings.temperature = 0
    localStorage.setItem('chat-settings', JSON.stringify(settings))
    localStorage.setItem('chat-models', JSON.stringify({
      state: { activeModel: model, lastLocalModel: model, lastCloudModel: null, categoryFilter: 'all' }, version: 0,
    }))
    localStorage.setItem('lu-providers', JSON.stringify({
      state: {
        hideBackendSelector: true,
        providers: {
          ollama: { id: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true },
          openai: { id: 'openai', name: 'LU Engine', enabled: false, baseUrl: 'http://localhost:8127/v1', apiKey: '', isLocal: true },
          anthropic: { id: 'anthropic', name: 'Anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKey: '', isLocal: false },
          'lu-cloud': { id: 'lu-cloud', name: 'LU Cloud', enabled: false, baseUrl: 'https://lu-labs.ai/api/inference/v1', apiKey: '', isLocal: false },
        },
      },
      version: 1,
    }))
    // The switches of the surface, as the user left them: no tools, thinking as the test says.
    const voice = JSON.parse(localStorage.getItem('locally-uncensored-voice') ?? '{"state":{},"version":0}')
    voice.state = { ...voice.state, loopAgent: false, loopThinking: thinking, loopThinkingBudget: budget, loopStartSound: false }
    localStorage.setItem('locally-uncensored-voice', JSON.stringify(voice))
  }, [LIVE.llmModel, opts.thinking, opts.budget ?? 512] as [string, boolean, number])
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()
  return { sessionRequests }
}

const probe = (page: Page) => page.evaluate(() => (window as unknown as { __voiceProbe: Probe }).__voiceProbe)
const history = (page: Page) => appModules(page, ['/src/stores/chatStore.ts']).then(() => page.evaluate(() => {
  const { useChatStore } = (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts']
  const list = useChatStore.getState().conversations as Array<{ messages: Array<{ role: string; content: string; thinking?: string }> }>
  return list[0]?.messages ?? []
}))
/** Marks of a thought that got out: its tags, or the way this model family begins one. */
const RAW_THOUGHT = /<\/?think>|\(Think\)|^Okay, (the user|so the user)|^The user (is asking|asks|wants)/i

test('thinking off: the answer is heard, and no thought is spoken or shown', async ({ page, browserName }) => {
  test.skip(process.env.LU_VOICE_LONG === '1', 'The long talk runs alone.')
  const { sessionRequests } = await boot(page, browserName, { thinking: false })
  const view = page.getByTestId('voice-view')
  await expect(view.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'false')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })
  const transcript = view.getByRole('list', { name: 'Transcript' })
  await expect(transcript.locator('[data-role="user"]').first()).toContainText(/sky|blue/i, { timeout: 90_000 })

  // What the speech engine was given is what the transcript shows as the answer.
  const answer = transcript.locator('[data-role="assistant"]').last()
  await expect(answer).toContainText(/\w{3,}/, { timeout: 120_000 })
  await expect.poll(async () => (await probe(page)).playedSeconds, { timeout: 120_000 }).toBeGreaterThan(1)
  await expect(view.getByTestId('voice-latency')).toContainText('Answered in', { timeout: 60_000 })
  const spoken = (await transcript.locator('[data-role="assistant"]').allTextContents()).join('\n')
  expect(spoken).not.toMatch(RAW_THOUGHT)
  // Thinking is off: no thought line either.
  await expect(transcript.locator('[data-role="thought"]')).toHaveCount(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/f1-thinking-off-answer-${browserName}.png` })

  await view.getByRole('button', { name: 'Stop voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle')
  const messages = await history(page)
  const answers = messages.filter((message) => message.role === 'assistant')
  expect(answers.map((message) => message.content).join(' ')).toMatch(/\w{3,}/)
  expect(answers.map((message) => message.content).join('\n')).not.toMatch(RAW_THOUGHT)
  // No tools were offered, and the voice loop was told not to let the model think.
  expect(sessionRequests).toHaveLength(1)
  expect(sessionRequests[0].active_tools).toEqual([])
  expect(sessionRequests[0].thinking).toMatchObject({ wanted: false })
})

test('thinking on: the thought is a folded block with its duration, the answer is still heard', async ({ page, browserName }) => {
  test.skip(process.env.LU_VOICE_LONG === '1', 'The long talk runs alone.')
  const { sessionRequests } = await boot(page, browserName, { thinking: true })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })
  const transcript = view.getByRole('list', { name: 'Transcript' })
  await expect(transcript.locator('[data-role="user"]').first()).toContainText(/sky|blue/i, { timeout: 90_000 })

  const thought = transcript.locator('[data-role="thought"]').first()
  await expect(thought.getByRole('button', { name: 'Toggle thinking details' })).toHaveText(/^Thought for \d+ s/, { timeout: 180_000 })
  const answer = transcript.locator('[data-role="assistant"]').last()
  await expect(answer).toContainText(/\w{3,}/, { timeout: 180_000 })
  await expect.poll(async () => (await probe(page)).playedSeconds, { timeout: 120_000 }).toBeGreaterThan(1)
  const spoken = (await transcript.locator('[data-role="assistant"]').allTextContents()).join('\n')
  expect(spoken).not.toMatch(RAW_THOUGHT)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/f2-thinking-on-folded-${browserName}.png` })
  await thought.getByRole('button', { name: 'Toggle thinking details' }).click()
  await expect(thought).toContainText(/\w{3,} \w{3,}/)
  if (SHOTS) await page.waitForTimeout(500)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/f2-thinking-on-open-${browserName}.png` })

  await view.getByRole('button', { name: 'Stop voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle')
  const answers = (await history(page)).filter((message) => message.role === 'assistant')
  expect(answers.map((message) => message.content).join('\n')).not.toMatch(RAW_THOUGHT)
  // The chat history keeps the thought where the chat shows it: in its Thinking block.
  expect(answers.map((message) => message.thinking ?? '').join('')).toMatch(/\w{3,}/)
  expect(sessionRequests[0].thinking).toMatchObject({ wanted: true, budget_tokens: 512 })
})

test('a talk of several questions: every one is answered aloud', async ({ page, browserName }) => {
  test.skip(process.env.LU_VOICE_LONG !== '1' || !talk, 'Set LU_VOICE_LONG=1 and LU_VOICE_TURNS=<n> for the long talk.')
  await boot(page, browserName, { thinking: false })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })
  const transcript = view.getByRole('list', { name: 'Transcript' })
  const total = talk!.lines[talk!.lines.length - 1].endSecs + 20
  await expect.poll(() => transcript.locator('[data-role="user"]').count(), { timeout: (total + 60) * 1000, intervals: [2000] }).toBeGreaterThanOrEqual(TURNS - 1)
  await page.waitForTimeout(15_000)
  const answers = await transcript.locator('[data-role="assistant"]').allTextContents()
  expect(answers.length).toBeGreaterThanOrEqual(TURNS - 1)
  expect(answers.join('\n')).not.toMatch(RAW_THOUGHT)
  expect((await probe(page)).playedSeconds).toBeGreaterThan(TURNS)
  // Hold the session for whoever measures the process from outside.
  if (process.env.LU_VOICE_HOLD_MS) await page.waitForTimeout(Number(process.env.LU_VOICE_HOLD_MS))
  await view.getByRole('button', { name: 'Stop voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle')
})
