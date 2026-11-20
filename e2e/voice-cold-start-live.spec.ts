import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { LIVE, LIVE_READY, fakeMicInit, spokenQuestion, startSidecar, type LiveSidecar } from './support/voice-live'

/**
 * A question asked while the speech models are still loading is answered.
 *
 * The first start after the app opened spends about eight seconds on
 * "Loading the speech models". The microphone is open from the click, and a
 * user who starts talking right away used to be ignored. Here the voice loop
 * is the REAL one with a real local model; the cold start is the mock's
 * `voice_loop_start` taking nine seconds, and the question is over before it
 * returns.
 *
 * Run:
 *   LU_E2E_CSP=1 LU_E2E_PORT=5273 LU_VOICE_PYTHON=<venv>/bin/python LU_VOICE_MODELS_DIR=<models> \
 *   LU_VOICE_LLM_MODEL=<ollama tag> npx playwright test e2e/voice-cold-start-live.spec.ts [--project=webkit]
 */

const QUESTION = 'How many days are in a week?'
const COLD_START_MS = 9000
// One second of silence, the question (under two seconds), then silence.
const wav = LIVE_READY ? spokenQuestion(QUESTION, 1, 3) : ''

test.skip(!LIVE_READY, 'Needs LU_VOICE_PYTHON, LU_VOICE_MODELS_DIR and LU_VOICE_LLM_MODEL (a real voice loop and a local model).')
test.setTimeout(240_000)
test.use({
  launchOptions: async ({ browserName }, apply) => {
    await apply(browserName === 'chromium'
      ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`] }
      : {})
  },
})

let sidecar: LiveSidecar

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  sidecar = await startSidecar(new URL(testInfo.project.use.baseURL ?? 'http://localhost:5273').origin)
})
test.afterAll(async () => {
  expect(await sidecar?.stop()).toBe(0)
})

test('what is said while the speech models load is heard and answered', async ({ page, browserName }) => {
  if (browserName !== 'chromium') await page.addInitScript(fakeMicInit, readFileSync(wav).toString('base64'))
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: 'unused-engine-model',
    platform: 'windows' as const,
    ollamaModels: [LIVE.llmModel],
    voiceLoop: { installed: true, session: { port: sidecar.port, token: sidecar.token }, startMs: COLD_START_MS },
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
  const view = page.getByTestId('voice-view')
  const session = view.getByTestId('voice-session')

  const clicked = Date.now()
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-status')).toContainText('Loading the speech models')
  // The whole question lies inside the cold start: it ends about 3.5 s after
  // the click, and the models are still loading well after that.
  await page.waitForTimeout(5000)
  await expect(view.getByTestId('voice-status')).toContainText('Loading the speech models')
  expect(Date.now() - clicked).toBeLessThan(COLD_START_MS)

  await expect(session).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })
  const transcript = view.getByRole('list', { name: 'Transcript' })
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ')
  await expect.poll(async () => words((await transcript.locator('[data-role="user"]').allTextContents()).join(' ')), { timeout: 30_000 })
    .toBe(words(QUESTION))
  await expect(transcript.locator('[data-role="assistant"]').first()).toContainText(/seven|7/i, { timeout: 60_000 })
})
