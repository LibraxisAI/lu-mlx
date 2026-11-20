import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { LIVE, LIVE_READY, spokenQuestion, startSidecar, type LiveSidecar } from './support/voice-live'
import { appModules, type AppWindow } from './support/ui'

/**
 * A voice session that works on the screen, against the REAL voice loop and a
 * REAL local model: the model in Ollama is the brain of the session (called
 * by the sidecar) and the model that looks at the screenshots (called by the
 * app). The user speaks; nothing is clicked.
 *
 * What is the mock: the Rust commands. The screen is three stored pictures
 * (e2e/fixtures/computer-task), and no real mouse, keyboard or screen is
 * touched. The microphone is a stream this spec plays recorded sentences
 * into, when it wants to, so "yes" can be said when the question is open.
 *
 * Also here, because only a real session can show it: a spoken "stop" pauses
 * the task and the session goes on, unloading Voice ends a task that waits or
 * is paused, and with "Workspace only" or with the Agent switch off a request
 * for the screen starts nothing of computer control.
 *
 * Run:
 *   LU_E2E_PORT=5273 LU_VOICE_PYTHON=<venv>/bin/python LU_VOICE_MODELS_DIR=<models> \
 *   LU_VOICE_LLM_MODEL=<ollama tag with tools and vision> \
 *   npx playwright test e2e/voice-screen-task-live.spec.ts --project=chromium
 */

const SHOTS = process.env.LU_VOICE_SHOTS
const MEASURE_OUT = process.env.LU_VOICE_MEASURE_OUT
const SENTENCES = {
  // Said the way it leaves no doubt that the screen is meant. "Save my note"
  // alone makes a 9B model ask for a file name (measured 06.10.2026).
  save: 'Click the Save button in the editor on my screen.',
  yes: 'Yes.',
  stop: 'Stop.',
  story: 'Tell me a long story about a lighthouse keeper.',
  sum: 'Wait. What is two plus two?',
}
type Clip = keyof typeof SENTENCES
const clips = LIVE_READY
  ? Object.fromEntries(Object.entries(SENTENCES).map(([name, text]) => [name, readFileSync(spokenQuestion(text, 0, 0)).toString('base64')])) as Record<Clip, string>
  : ({} as Record<Clip, string>)
const screen = (name: string) => readFileSync(resolve(process.cwd(), 'e2e/fixtures/computer-task', name)).toString('base64')

test.skip(!LIVE_READY, 'Needs LU_VOICE_PYTHON, LU_VOICE_MODELS_DIR and LU_VOICE_LLM_MODEL (a real voice loop and a local model that sees).')
test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } })

let sidecar: LiveSidecar
const measured: Record<string, unknown> = { model: LIVE.llmModel }

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  sidecar = await startSidecar(new URL(testInfo.project.use.baseURL ?? 'http://localhost:5273').origin)
})
test.afterAll(async () => {
  expect(await sidecar?.stop()).toBe(0)
  if (MEASURE_OUT) writeFileSync(MEASURE_OUT, JSON.stringify(measured, null, 2))
})

// A failed live run says what the session looked like: these runs cannot be replayed.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return
  const view = page.getByTestId('voice-view')
  console.log('[state at failure]', JSON.stringify({
    status: await view.getByTestId('voice-status').textContent({ timeout: 1000 }).catch(() => null),
    transcript: await page.getByRole('list', { name: 'Transcript' }).locator('li').allTextContents().catch(() => []),
    tools: await view.getByRole('group', { name: 'Tools' }).textContent({ timeout: 1000 }).catch(() => null),
    bar: await page.getByTestId('computer-control-bar').textContent({ timeout: 1000 }).catch(() => null),
    questions: await page.getByTestId('computer-question').allTextContents().catch(() => []),
  }, null, 1))
})

interface Mic { say: (name: string) => Promise<number>; stops: number[] }

/** A microphone the spec talks into, and a clock on when queued speech was cut. */
function micInit(recordings: Record<string, string>) {
  const context = new AudioContext()
  const sink = context.createMediaStreamDestination()
  const buffers = new Map<string, Promise<AudioBuffer>>()
  for (const [name, base64] of Object.entries(recordings)) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    buffers.set(name, context.decodeAudioData(bytes.buffer))
  }
  const mic: Mic = {
    stops: [],
    say: async (name) => {
      await context.resume()
      const buffer = await buffers.get(name)!
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(sink)
      source.start()
      return buffer.duration
    },
  }
  ;(window as unknown as { __mic: Mic }).__mic = mic
  MediaDevices.prototype.getUserMedia = async () => { void context.resume(); return sink.stream }
  MediaDevices.prototype.enumerateDevices = async () => [
    { deviceId: 'recording', groupId: 'e2e', kind: 'audioinput', label: 'Recorded sentences', toJSON: () => ({}) } as MediaDeviceInfo,
  ]
  // Speech of the assistant that is cut off is stopped on its source node.
  const stop = AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.stop = function (...args: [number?]) {
    mic.stops.push(performance.now())
    return stop.apply(this, args)
  }
}

async function boot(page: Page, work: { agent: boolean; scope: 'workspace' | 'computer' } = { agent: true, scope: 'computer' }) {
  // LU_VOICE_SESSION_DUMP=<file> keeps what the surface asked the voice loop for, without the key.
  page.on('request', (request) => {
    if (!process.env.LU_VOICE_SESSION_DUMP || !request.url().endsWith('/session') || request.method() !== 'POST') return
    const body = JSON.parse(request.postData() ?? '{}') as { llm?: { api_key?: string } }
    if (body.llm) body.llm.api_key = ''
    writeFileSync(process.env.LU_VOICE_SESSION_DUMP, JSON.stringify(body, null, 1))
  })
  await page.addInitScript(micInit, clips)
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: 'unused-engine-model',
    platform: 'windows' as const,
    ollamaModels: [LIVE.llmModel],
    ollamaLive: true,
    voiceLoop: { installed: true, session: { port: sidecar.port, token: sidecar.token } },
    // The window stays a window with its bar here. The panel is in computer-surface.spec.ts.
    computer: { shrinks: false, screens: ['01-editor.jpg', '02-save-dialog.jpg', '03-saved.jpg'].map(screen) },
  })
  await seedOnboardingDone(page)
  await page.addInitScript(({ model, work }: { model: string; work: { agent: boolean; scope: string } }) => {
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
    // Computer control is on, the way the user switched it on in the settings.
    // The screen belongs to "Whole computer", and the user said yes to that level before.
    localStorage.setItem('locally-uncensored-voice', JSON.stringify({
      state: { loopAgent: work.agent, loopScope: work.scope, loopComputerConfirmed: true }, version: 0,
    }))
    localStorage.setItem('locally-uncensored-computer', JSON.stringify({
      state: { enabled: true, alwaysAllowed: [], executorModel: null }, version: 1,
    }))
  }, { model: LIVE.llmModel, work })
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()
}

/** Start a session and report how long "getting ready" took. */
async function startSession(page: Page): Promise<{ startMs: number; sawGettingReady: boolean }> {
  const view = page.getByTestId('voice-view')
  const began = Date.now()
  await view.getByRole('button', { name: 'Start voice' }).click()
  let sawGettingReady = false
  const status = view.getByTestId('voice-status')
  await expect(async () => {
    if ((await status.textContent())?.startsWith('Getting ready')) sawGettingReady = true
    expect(await view.getByTestId('voice-session').getAttribute('data-phase')).toBe('live')
  }).toPass({ timeout: 240_000, intervals: [100] })
  return { startMs: Date.now() - began, sawGettingReady }
}

/** Speak a recorded sentence into the microphone and wait until it is out. */
async function say(page: Page, clip: Clip): Promise<{ startedAt: number; endedAt: number }> {
  const startedAt = await page.evaluate(() => performance.now())
  const secs = await page.evaluate((name) => (window as unknown as { __mic: Mic }).__mic.say(name), clip)
  await page.waitForTimeout(secs * 1000)
  return { startedAt, endedAt: startedAt + secs * 1000 }
}

const activity = (page: Page) => page.getByTestId('voice-session').getAttribute('data-activity')
const now = (page: Page) => page.evaluate(() => performance.now())
const computerCalls = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_COMPUTER_CALLS__?: { cmd: string }[] }).__E2E_COMPUTER_CALLS__ ?? []).map((call) => call.cmd))
const fired = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_COMPUTER_FIRED__?: { action: { type: string } }[] }).__E2E_COMPUTER_FIRED__ ?? [])
const latencySecs = async (page: Page) => {
  const text = await page.getByTestId('voice-latency').textContent()
  const match = /Answered in ([\d.]+) (ms|s)/.exec(text ?? '')
  return match ? Number(match[1]) / (match[2] === 'ms' ? 1000 : 1) : null
}

/** Wait until the assistant is not talking, so an answer is not spoken into its question. */
async function waitQuiet(page: Page) {
  await expect.poll(() => activity(page), { timeout: 30_000, intervals: [100] }).not.toBe('speaking')
  await page.waitForTimeout(400)
}

test('a second sentence cuts the answer off at once, and the wait shown is that of the second answer', async ({ page }) => {
  await boot(page)
  const start = await startSession(page)
  measured.start = start
  expect(start.sawGettingReady).toBe(true)

  const transcript = page.getByRole('list', { name: 'Transcript' })
  const story = await say(page, 'story')
  await expect.poll(() => activity(page), { timeout: 90_000, intervals: [50] }).toBe('speaking')
  const firstSound = await now(page)
  measured.firstAnswer = { fromEndOfSentenceToSpeakingMs: Math.round(firstSound - story.endedAt), shownSecs: await latencySecs(page) }
  // The first answer of the session came without the long first read.
  expect(firstSound - story.endedAt).toBeLessThan(15_000)

  // Two seconds into the answer the user speaks again.
  await page.waitForTimeout(2000)
  expect(await activity(page)).toBe('speaking')
  const cut = await say(page, 'sum')
  const stops = await page.evaluate(() => (window as unknown as { __mic: Mic }).__mic.stops)
  const firstStop = stops.find((at) => at >= cut.startedAt)
  expect(firstStop, 'the queued speech was stopped after the user began to speak').toBeDefined()
  measured.interruption = { fromFirstWordToSilenceMs: Math.round(firstStop! - cut.startedAt) }
  // Speech detection needs a few hundred milliseconds of voice before it is sure.
  expect(firstStop! - cut.startedAt).toBeLessThan(1500)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/20-voice-interrupted.png` })

  // The second question is answered.
  await expect(transcript.locator('[data-role="assistant"]').last()).toContainText(/four|4/i, { timeout: 90_000 })
  await expect.poll(() => activity(page), { timeout: 30_000, intervals: [50] }).toBe('speaking')
  const secondSound = await now(page)
  await expect.poll(() => latencySecs(page), { timeout: 10_000 }).not.toBeNull()
  const shown = (await latencySecs(page))!
  const real = (secondSound - cut.endedAt) / 1000
  measured.secondAnswer = { fromEndOfSentenceToSpeakingMs: Math.round(real * 1000), shownSecs: shown, sessionAgeSecs: Math.round(secondSound / 1000) }
  // The readout is the wait for THIS answer, not the age of the session.
  expect(Math.abs(shown - real)).toBeLessThan(1.5)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/21-voice-second-answer.png` })
  await page.getByTestId('voice-view').getByRole('button', { name: 'Stop voice' }).click()
})

test('a task on the screen by voice: asked aloud, answered with yes, never clicked', async ({ page }) => {
  await boot(page)
  await startSession(page)
  const view = page.getByTestId('voice-view')
  const asked = await say(page, 'save')

  const question = page.getByTestId('computer-question')
  const bar = page.getByTestId('computer-control-bar')
  let questions = 0
  let firstQuestionAt = 0
  const stepTimes: number[] = []
  // Every question is answered by voice until the task is over.
  for (let round = 0; round < 10; round += 1) {
    const open = await expect.poll(async () => {
      if (await question.count()) return 'question'
      // The list is not there before the first tool.
      // The tool call is the chat's tool block in the transcript: its name and state are attributes.
      const state = await view.locator('[data-tool="computer_task"]').last().getAttribute('data-status', { timeout: 300 }).catch(() => null)
      return state === 'completed' || state === 'failed' || state === 'rejected' ? 'over' : 'running'
    }, { timeout: 120_000, intervals: [200] }).not.toBe('running').then(async () => (await question.count()) ? 'question' : 'over')
    if (open === 'over') break
    questions += 1
    if (!firstQuestionAt) firstQuestionAt = await now(page)
    stepTimes.push(await now(page))
    const title = await question.getByRole('heading').first().textContent()
    if (questions === 1) {
      expect(title).toBe('Allow LU to control Notepad?')
      await expect(view.getByTestId('voice-status')).toHaveText('Waiting for your answer')
      await expect(bar.getByTestId('computer-task-progress')).toContainText('Task:')
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/22-voice-task-question.png` })
    }
    // The question is spoken. The answer comes after it.
    await waitQuiet(page)
    const before = (await fired(page)).length
    await say(page, 'yes')
    await expect(question.getByRole('heading', { name: title ?? '' })).toHaveCount(0, { timeout: 20_000 })
    if (title === 'Confirm this action') await expect.poll(async () => (await fired(page)).length, { timeout: 20_000 }).toBe(before + 1)
  }
  expect(questions).toBeGreaterThanOrEqual(2)
  const actions = await fired(page)
  expect(actions.length).toBeGreaterThanOrEqual(1)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/23-voice-task-done.png` })

  // The assistant tells the result aloud.
  const transcript = page.getByRole('list', { name: 'Transcript' })
  await expect(transcript.locator('[data-role="assistant"]').last()).toContainText(/\w+/, { timeout: 120_000 })
  await expect.poll(() => activity(page), { timeout: 120_000, intervals: [100] }).toBe('listening')
  measured.task = {
    fromRequestToFirstQuestionMs: Math.round(firstQuestionAt - asked.endedAt),
    questionsAnsweredByVoice: questions,
    actions: actions.map((a) => a.action.type),
    msBetweenQuestions: stepTimes.slice(1).map((at, i) => Math.round(at - stepTimes[i])),
    said: await transcript.locator('[data-role="assistant"]').allTextContents(),
  }
  await view.getByRole('button', { name: 'Stop voice' }).click()

  // The chat history has the task as a tool call, and no screenshot in it.
  await appModules(page, ['/src/stores/chatStore.ts'])
  const conversation = await page.evaluate(() => {
    const { useChatStore } = (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts']
    return JSON.stringify((useChatStore.getState().conversations as unknown[])[0])
  })
  expect(conversation).toContain('computer_task')
  expect(conversation).not.toContain('data:image')
})

test('"stop" by voice pauses the task: the session goes on, the question comes back after "Let it continue", and "Take over" ends it', async ({ page }) => {
  await boot(page)
  await startSession(page)
  const view = page.getByTestId('voice-view')
  await say(page, 'save')
  const question = page.getByRole('group', { name: 'Allow LU to control Notepad?' })
  await expect(question).toBeVisible({ timeout: 180_000 })
  await waitQuiet(page)
  const stop = await say(page, 'stop')
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible({ timeout: 15_000 })
  measured.stop = { fromEndOfWordToPausedMs: Math.round((await now(page)) - stop.endedAt) }
  await expect(paused).toContainText('You asked LU to wait. LU does nothing until you choose.')
  await expect(paused.getByRole('button', { name: 'Take over' })).toBeFocused()
  // Paused through the engine, not stopped, and nothing ran.
  expect(await computerCalls(page)).toContain('computer_pause')
  expect(await computerCalls(page)).not.toContain('computer_stop')
  expect(await fired(page)).toEqual([])
  // The session is alive behind the paused view, and the task is still its running call.
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live')
  await expect(view.getByTestId('voice-status')).toHaveText('Paused')
  await expect(paused.getByTestId('computer-activity').locator('[data-tool="computer_task"]')).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/24-voice-task-paused.png` })

  // A "yes" said now answers nothing: the question is not open for the voice while paused.
  await say(page, 'yes')
  await page.waitForTimeout(1500)
  await expect(paused).toBeVisible()
  expect(await fired(page)).toEqual([])

  await paused.getByRole('button', { name: 'Let it continue' }).click()
  await expect(paused).toHaveCount(0)
  await expect(question).toBeVisible()
  await expect(view.getByTestId('voice-status')).toHaveText('Waiting for your answer')

  // Paused again by voice, and this time the user takes over.
  await waitQuiet(page)
  await say(page, 'stop')
  await expect(paused).toBeVisible({ timeout: 15_000 })
  await paused.getByRole('button', { name: 'Take over' }).click()
  await expect(paused).toHaveCount(0)
  await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped.', { timeout: 15_000 })
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  expect(await fired(page)).toEqual([])
  await expect(page.getByTestId('computer-task-progress')).toHaveCount(0, { timeout: 15_000 })
  // The session is still there after the task: the model says what happened.
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/25-voice-task-taken-over.png` })
  await view.getByRole('button', { name: 'Stop voice' }).click()
})

for (const state of ['waits for an answer', 'is paused'] as const) {
  test(`unloading Voice while a screen task ${state} ends the task and leaves nothing of it`, async ({ page }) => {
    await boot(page)
    await startSession(page)
    const view = page.getByTestId('voice-view')
    await say(page, 'save')
    await expect(page.getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible({ timeout: 180_000 })
    await waitQuiet(page)
    if (state === 'is paused') {
      await say(page, 'stop')
      await expect(page.getByRole('alertdialog', { name: 'LU has paused' })).toBeVisible({ timeout: 15_000 })
      // The paused view covers the window, so the light switch is not in reach: Voice is unloaded the way the switch does it.
      // Not awaited across the protocol (see appModules in support/ui.ts): the checks below wait for the outcome.
      await page.evaluate(() => {
        void import('/src/api/voice-session.ts' as string).then(({ unloadVoiceEngine }) => unloadVoiceEngine())
      })
    } else {
      await view.getByTestId('voice-unload').click()
    }
    await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle', { timeout: 15_000 })
    await expect(page.getByRole('alertdialog', { name: 'LU has paused' })).toHaveCount(0)
    await expect(page.getByTestId('computer-question')).toHaveCount(0)
    await expect(page.getByTestId('computer-surface')).toHaveCount(0)
    await expect(page.getByTestId('computer-task-progress')).toHaveCount(0, { timeout: 15_000 })
    expect(await computerCalls(page)).toContain('computer_stop')
    expect(await computerCalls(page)).not.toContain('computer_takeover_answer')
    expect(await fired(page)).toEqual([])
    // The window is the window, and Voice can be started again.
    await expect(page.locator('#root')).toHaveCSS('visibility', 'visible')
    await expect(view.getByRole('button', { name: /Start/ })).toBeVisible()
    // The bar goes with the work: a few seconds after the stop note is closed or the linger is over.
    const bar = page.getByTestId('computer-control-bar')
    if (await bar.count()) await expect(bar).not.toContainText('LU is controlling this computer', { timeout: 15_000 })
  })
}

for (const work of [{ agent: true, scope: 'workspace' as const, name: '"Workspace only"' }, { agent: false, scope: 'computer' as const, name: 'the Agent switch off' }]) {
  test(`with ${work.name} a request for the screen starts nothing of computer control`, async ({ page }) => {
    await boot(page, work)
    await startSession(page)
    const view = page.getByTestId('voice-view')
    const transcript = page.getByRole('list', { name: 'Transcript' })
    await say(page, 'save')
    // The model answers in words. A tool of the folder it may try instead is declined.
    await expect(async () => {
      const deny = view.getByTestId('voice-approval').getByRole('button', { name: /deny|reject|no/i }).first()
      if (await deny.count()) await deny.click()
      expect(await transcript.locator('[data-role="assistant"]').count()).toBeGreaterThan(0)
      expect(await activity(page)).toBe('listening')
    }).toPass({ timeout: 180_000, intervals: [500] })
    measured[`said with ${work.name}`] = await transcript.locator('[data-role="assistant"]').allTextContents()
    // Nothing of computer control: no question, no bar, no pill, no session in Rust.
    await expect(page.getByTestId('computer-question')).toHaveCount(0)
    await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
    await expect(page.getByTestId('computer-surface')).toHaveCount(0)
    await expect(view.locator('[data-tool="computer_task"][data-status="completed"]')).toHaveCount(0)
    expect(await computerCalls(page)).toEqual([])
    expect(await fired(page)).toEqual([])
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/26-voice-no-screen-${work.scope}-${work.agent ? 'agent' : 'talk'}.png` })
    await view.getByRole('button', { name: 'Stop voice' }).click()
  })
}
