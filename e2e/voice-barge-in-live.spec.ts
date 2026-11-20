import { appendFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { LIVE, LIVE_READY, spokenScript, startSidecar, warmLocalModel, type LiveSidecar } from './support/voice-live'

/**
 * Speaking while LU speaks, against the REAL voice loop and a real local
 * model: the sentence that interrupts an answer arrives whole.
 *
 * The microphone is Chromium's fake capture device playing a recording, so
 * the sentence takes the same road as a real microphone: through the
 * webview's audio processing (echo cancellation, noise suppression, gain
 * control), while the answer is playing on the output.
 *
 * Run (five times, one fresh browser and session each):
 *   LU_E2E_PORT=5273 LU_VOICE_PYTHON=<venv>/bin/python LU_VOICE_MODELS_DIR=<models> \
 *   LU_VOICE_LLM_MODEL=<ollama tag> LU_VOICE_MEASURE_OUT=<file.jsonl> \
 *   npx playwright test e2e/voice-barge-in-live.spec.ts --project=chromium --repeat-each=5
 */

const MEASURE_OUT = process.env.LU_VOICE_MEASURE_OUT
const STORY = 'Tell me a very long story about a lighthouse keeper.'
const CUT = 'Hold on, how many days are in a week?'
// The answer starts one to three seconds after the story request ends, and
// the user speaks again two to three seconds into it.
const script = LIVE_READY
  ? spokenScript([{ text: STORY, pauseSecs: Number(process.env.LU_VOICE_CUT_AFTER_SECS ?? 4.5) }, { text: CUT, pauseSecs: 30, voice: 'Daniel' }], 15)
  : { file: '', lines: [] }

test.skip(!LIVE_READY, 'Needs LU_VOICE_PYTHON, LU_VOICE_MODELS_DIR and LU_VOICE_LLM_MODEL (a real voice loop and a local model).')
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({
  // LU_VOICE_CHANNEL=chromium runs the full browser build instead of the headless shell.
  channel: process.env.LU_VOICE_CHANNEL || undefined,
  launchOptions: {
    args: [
      ...(process.env.LU_VOICE_BROWSER_ARGS ?? '').split(' ').filter(Boolean),
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${script.file}%noloop`,
    ],
  },
})

let sidecar: LiveSidecar

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  // The recording runs on a fixed timeline from the click on Start, so the model is in memory before it.
  await warmLocalModel()
  sidecar = await startSidecar(new URL(testInfo.project.use.baseURL ?? 'http://localhost:5273').origin)
})
test.afterAll(async () => {
  expect(await sidecar?.stop()).toBe(0)
})

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: 'unused-engine-model',
    platform: 'windows' as const,
    ollamaModels: [LIVE.llmModel],
    voiceLoop: { installed: true, session: { port: sidecar.port, token: sidecar.token } },
  })
  await seedOnboardingDone(page)
  await page.addInitScript((model: string) => {
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
  }, LIVE.llmModel)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ')

test('a sentence spoken into the answer arrives whole', async ({ page }) => {
  await boot(page)
  const view = page.getByTestId('voice-view')
  const session = view.getByTestId('voice-session')
  // The fake microphone starts its recording when it is opened, at this click.
  const opened = Date.now()
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(session).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })

  const cut = script.lines[1]
  const activity = () => session.getAttribute('data-activity')
  const transcript = view.getByRole('list', { name: 'Transcript' })
  const userLines = () => transcript.locator('[data-role="user"]').allTextContents()

  // The answer to the story request is being spoken when the user speaks again.
  let speakingAt = 0
  await expect(async () => {
    expect(await activity()).toBe('speaking')
    speakingAt = Date.now()
  }).toPass({ timeout: cut.startSecs * 1000 + 5000, intervals: [50] })
  const cutStart = opened + cut.startSecs * 1000
  await page.waitForTimeout(Math.max(0, cutStart - Date.now()))
  const activityAtCut = await activity()

  // Everything the user said after the story request, in order.
  let after = ''
  const whole = async () => {
    const lines = (await userLines()).map(words)
    const story = lines.findIndex((line) => line.includes('lighthouse'))
    after = lines.slice(story + 1).join(' ')
    return after
  }
  await expect.poll(whole, { timeout: 40_000, intervals: [250] }).toContain('week')
  // A second piece of the sentence may still be on its way.
  await page.waitForTimeout(2500)
  await whole()
  const result = {
    cutAfterSpeakingMs: Math.round(cutStart - speakingAt),
    activityAtCut,
    expected: words(CUT),
    heard: after,
    complete: after === words(CUT),
  }
  if (MEASURE_OUT) appendFileSync(MEASURE_OUT, `${JSON.stringify(result)}\n`)
  console.log('[barge-in]', JSON.stringify(result))

  expect(activityAtCut, 'LU was speaking when the user began').toBe('speaking')
  expect(after).toBe(words(CUT))
  // And the new question is the one that gets answered.
  await expect(transcript.locator('[data-role="assistant"]').last()).toContainText(/seven|7/i, { timeout: 60_000 })
  await view.getByRole('button', { name: 'Stop voice' }).click()
})
