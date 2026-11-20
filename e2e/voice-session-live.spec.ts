import { readFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { LIVE, LIVE_READY, fakeMicInit, spokenQuestion, startSidecar, type LiveSidecar } from './support/voice-live'
import { appModules, type AppWindow } from './support/ui'

/**
 * The Voice surface against the REAL voice loop, a real local model and the
 * app's own Content-Security-Policy.
 *
 * What is real: the React app with its provider system, tool registry and
 * permission store, the Pipecat client and WebSocket transport, the app's own
 * media manager with its AudioWorklet, the Python sidecar (speech detection,
 * Whisper, the speech engine), and the model in Ollama that the sidecar calls.
 * What is the mock: the Rust commands. The setup is its scripted walk through
 * the phases, `voice_loop_start` hands out the port and token of the sidecar
 * this spec started, and the file tool reads from a canned file.
 *
 * The microphone is a recorded question. Chromium plays it through its fake
 * capture device. WebKit has no such device, so there getUserMedia is
 * replaced by a stream that plays the same recording.
 *
 * Run (the policy only counts with LU_E2E_CSP=1, and that needs its own server):
 *
 *   LU_E2E_CSP=1 LU_E2E_PORT=5273 \
 *   LU_VOICE_PYTHON=<venv>/bin/python LU_VOICE_MODELS_DIR=<models> \
 *   LU_VOICE_LLM_MODEL=<ollama tag with tools> \
 *   npx playwright test e2e/voice-session-live.spec.ts [--project=webkit]
 */

const SHOTS = process.env.LU_VOICE_SHOTS
const CSP_ON = process.env.LU_E2E_CSP === '1'
// Writing a file changes something on the computer, so it needs approval.
const QUESTION = 'Write the words milk and bread into a file called shopping dot t x t.'
// The recording starts when the microphone opens, which is at the Start click.
// A local model is warmed up before the session is live (up to about ten
// seconds on a cold start), so the question comes after a long lead of silence.
const wav = LIVE_READY ? spokenQuestion(QUESTION, 15) : ''

test.skip(!LIVE_READY, 'Needs LU_VOICE_PYTHON, LU_VOICE_MODELS_DIR and LU_VOICE_LLM_MODEL (a real voice loop and a local model).')
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test.use({
  launchOptions: async ({ browserName }, apply) => {
    await apply(browserName === 'chromium'
      ? { args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          // Played once, then the fake microphone is silent.
          `--use-file-for-fake-audio-capture=${wav}%noloop`,
        ] }
      : {})
  },
})

let sidecar: LiveSidecar

// Playwright wants the fixtures destructured, also when none is used.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  const origin = new URL(testInfo.project.use.baseURL ?? 'http://localhost:5273').origin
  sidecar = await startSidecar(origin)
})

test.afterAll(async () => {
  // Closing stdin is how the app stops the voice loop. It must exit cleanly.
  expect(await sidecar?.stop()).toBe(0)
})

interface Probe {
  violations: string[]
  worklets: Array<{ url: string; ok: boolean }>
  scriptProcessors: number
  played: number
  playedSeconds: number
  stopped: number
}

/** Watches what the policy refuses and what the audio graph does. */
function probeInit(opts: { failWorklet: boolean }) {
  const probe: Probe = { violations: [], worklets: [], scriptProcessors: 0, played: 0, playedSeconds: 0, stopped: 0 }
  ;(window as unknown as { __voiceProbe: Probe }).__voiceProbe = probe
  document.addEventListener('securitypolicyviolation', (event) => {
    probe.violations.push(`${event.effectiveDirective} ${event.blockedURI}`)
  })
  const worklet = (window as unknown as { AudioWorklet?: { prototype: AudioWorklet } }).AudioWorklet
  if (worklet) {
    const addModule = worklet.prototype.addModule
    worklet.prototype.addModule = function (url: string | URL, options?: WorkletOptions) {
      if (opts.failWorklet) {
        probe.worklets.push({ url: String(url), ok: false })
        return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
      }
      return addModule.call(this, url, options).then(
        () => { probe.worklets.push({ url: String(url), ok: true }) },
        (error: unknown) => { probe.worklets.push({ url: String(url), ok: false }); throw error },
      )
    }
  }
  const Base = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const createScriptProcessor = Base.prototype.createScriptProcessor
  Base.prototype.createScriptProcessor = function (...args: [number?, number?, number?]) {
    probe.scriptProcessors += 1
    return createScriptProcessor.apply(this, args)
  }
  const start = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...args: [number?, number?, number?]) {
    probe.played += 1
    probe.playedSeconds += this.buffer?.duration ?? 0
    return start.apply(this, args)
  }
  const stop = AudioBufferSourceNode.prototype.stop
  AudioBufferSourceNode.prototype.stop = function (...args: [number?]) {
    probe.stopped += 1
    return stop.apply(this, args)
  }
}

async function boot(page: Page, browserName: string, opts: { installed: boolean; failWorklet?: boolean }) {
  const foreign = new Set<string>()
  const local = (url: string) => ['localhost', '127.0.0.1'].includes(new URL(url).hostname)
  page.on('request', (request) => {
    if (/^(https?|wss?):/.test(request.url()) && !local(request.url())) foreign.add(new URL(request.url()).origin)
  })
  page.on('websocket', (socket) => { if (!local(socket.url())) foreign.add(new URL(socket.url()).origin) })
  // What the surface asked the voice loop for, without the model's key.
  const sessionRequests: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/session') || request.method() !== 'POST') return
    const body = JSON.parse(request.postData() ?? '{}') as { llm?: Record<string, unknown>; tools?: Array<{ function: { name: string } }>; long_running_tools?: string[]; system_prompt?: string }
    sessionRequests.push({
      llm: { ...body.llm, api_key: body.llm?.api_key ? '[set]' : undefined },
      tools: body.tools?.map((tool) => tool.function.name),
      longRunning: body.long_running_tools,
      promptChars: body.system_prompt?.length,
    })
  })
  const consoleErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.addInitScript(probeInit, { failWorklet: opts.failWorklet === true })
  if (browserName !== 'chromium') await page.addInitScript(fakeMicInit, readFileSync(wav).toString('base64'))
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: 'unused-engine-model',
    platform: 'mac' as const,
    ollamaModels: [LIVE.llmModel],
    voiceLoop: { installed: opts.installed, session: { port: sidecar.port, token: sidecar.token } },
  })
  await seedOnboardingDone(page)
  await page.addInitScript((model: string) => {
    // Temperature 0: the proof is about the path, not about the model's mood.
    const settings = JSON.parse(localStorage.getItem('chat-settings')!)
    settings.state.settings.temperature = 0
    localStorage.setItem('chat-settings', JSON.stringify(settings))
    // The selected chat model is an Ollama model, the way a user with Ollama
    // has it (same fixture shape as topnav-centering.spec.ts).
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
  return { foreign, consoleErrors, sessionRequests }
}

const probe = (page: Page) => page.evaluate(() => (window as unknown as { __voiceProbe: Probe }).__voiceProbe)

test('setup, a spoken question, a tool call with approval, the spoken answer, stop', async ({ page, browserName }) => {
  const { foreign, consoleErrors, sessionRequests } = await boot(page, browserName, { installed: false })
  const view = page.getByTestId('voice-view')
  const session = view.getByTestId('voice-session')

  // The page really is under the app's policy.
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content').catch(() => null)
  if (CSP_ON) expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'")

  // First visit: the setup (scripted by the mock), then the session.
  await view.getByRole('button', { name: 'Install' }).click()
  await expect(view.getByTestId('voice-setup-progress')).toBeVisible()
  const start = view.getByRole('button', { name: 'Start voice' })
  await expect(start).toBeVisible({ timeout: 30_000 })

  // One click starts everything. The recording begins after a few seconds of silence.
  await start.click()
  await expect(session).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })
  await expect(view.getByRole('button', { name: 'Stop voice' })).toBeVisible()
  await expect(view.getByRole('button', { name: 'Mute microphone' })).toBeVisible()

  // The question arrives as text.
  const transcript = view.getByRole('list', { name: 'Transcript' })
  const said = transcript.locator('[data-role="user"]').first()
  await expect(said).toContainText(/file|shopping|milk|bread/i, { timeout: 60_000 })
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/10-session-live-${browserName}.png` })

  // The model wants to write the file. That needs approval, as in the agent chat.
  // It asks with the approval strip of the chat, and the call stands in the
  // transcript as the chat's tool block, open, with what it would write.
  const strip = view.getByTestId('voice-approval')
  const approve = strip.getByRole('button', { name: 'Approve', exact: true })
  await expect(approve).toBeVisible({ timeout: 90_000 })
  await expect(view.getByTestId('voice-status')).toHaveText('Waiting for your approval')
  // The strip asks in words; the tool's own name is its tooltip and sits behind the arrow.
  const what = strip.getByTestId('approval-what')
  await expect(what).toHaveText('Voice wants to change a file. Nothing happens until you answer.')
  await expect(what).toHaveAttribute('title', 'file_write')
  await expect(strip).not.toContainText('file_write')
  const block = view.locator('[data-tool="file_write"]').last()
  await expect(block).toHaveAttribute('data-status', 'pending_approval')
  await expect(block.locator('pre').first()).toContainText(/milk/i)
  await strip.getByTitle('Show arguments').click()
  await expect(strip.locator('pre')).toContainText('file_write')
  await expect(strip.locator('pre')).toContainText(/milk/i)
  // Nothing was written before the click.
  const written = () => page.evaluate(() => ((window as unknown as { __E2E_TOOL_CALLS__?: Array<{ cmd: string; path?: string; content?: string }> }).__E2E_TOOL_CALLS__ ?? []).filter((call) => call.cmd === 'fs_write'))
  expect(await written()).toHaveLength(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/11-session-approval-${browserName}.png` })
  await approve.click()

  // The tool ran exactly once, and the model says so.
  await expect(block).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  const answer = transcript.locator('[data-role="assistant"]').last()
  await expect(answer).toContainText(/\w+/, { timeout: 90_000 })
  const writes = await written()
  expect(writes).toHaveLength(1)
  expect(writes[0].path).toMatch(/shopping/i)
  expect(writes[0].content).toMatch(/milk/i)

  // The answer was audible: speech was scheduled on the audio output.
  await expect.poll(async () => (await probe(page)).playedSeconds, { timeout: 60_000 }).toBeGreaterThan(1)
  await expect(view.getByTestId('voice-latency')).toContainText('Answered in', { timeout: 30_000 })
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/12-session-answer-${browserName}.png` })

  // The session is a normal conversation in the chat history.
  await appModules(page, ['/src/stores/chatStore.ts'])
  const conversation = await page.evaluate(() => {
    const { useChatStore } = (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts']
    const list = useChatStore.getState().conversations as Array<{ title: string; mode?: string; messages: Array<{ role: string; content: string; modelId?: string; agentBlocks?: Array<{ content: string; toolCalls?: Array<{ toolName: string; status: string; result?: string }> }> }> }>
    return list[0]
  })
  expect(conversation.mode).toBe('lu')
  expect(conversation.messages[0]).toMatchObject({ role: 'user' })
  expect(conversation.messages[0].content).toMatch(/file|shopping|milk|bread/i)
  const answers = conversation.messages.filter((m) => m.role === 'assistant')
  expect(answers.map((m) => m.content).join(' ').trim().length).toBeGreaterThan(3)
  const blocks = answers.flatMap((m) => m.agentBlocks ?? [])
  expect(blocks).toHaveLength(1)
  expect(blocks[0].content).toBe('Completed: file_write')
  expect(blocks[0].toolCalls?.[0]).toMatchObject({ toolName: 'file_write', status: 'completed' })

  // Stop ends it at once and releases the microphone.
  await view.getByRole('button', { name: 'Stop voice' }).click()
  await expect(session).toHaveAttribute('data-phase', 'idle')
  await expect(view.getByRole('button', { name: 'Start voice' })).toBeVisible()
  await expect(transcript.locator('[data-role="assistant"]').last()).toContainText(/\w+/)

  // The brain is the selected chat model through its provider, thinking off,
  // and every tool that may wait for an approval is announced as such.
  expect(sessionRequests).toHaveLength(1)
  expect(sessionRequests[0].llm).toMatchObject({ base_url: 'http://localhost:11434/v1', model: LIVE.llmModel })
  expect(sessionRequests[0].tools).toContain('file_write')
  expect(sessionRequests[0].longRunning).toContain('file_write')

  // How the audio travelled, and what the policy had to say about it.
  const seen = await probe(page)
  expect(seen.worklets).toEqual([{ url: expect.stringMatching(/\/voice\/capture-worklet\.js$/), ok: true }])
  expect(seen.scriptProcessors).toBe(0)
  expect(seen.violations).toEqual([])
  expect(consoleErrors.filter((line) => /Content Security Policy|Refused to/i.test(line))).toEqual([])
  expect([...foreign]).toEqual([])
  // Neither the launch token nor any key is in what the surface persisted.
  const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(persisted).not.toContain(sidecar.token)
})

test('a webview that cannot load the worklet module still hears the user', async ({ page, browserName }) => {
  const { foreign } = await boot(page, browserName, { installed: true, failWorklet: true })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live', { timeout: 180_000 })
  await expect(view.getByRole('list', { name: 'Transcript' }).locator('[data-role="user"]').first())
    .toContainText(/file|shopping|milk|bread/i, { timeout: 60_000 })
  const seen = await probe(page)
  expect(seen.worklets).toEqual([{ url: expect.stringMatching(/\/voice\/capture-worklet\.js$/), ok: false }])
  expect(seen.scriptProcessors).toBe(1)
  expect(seen.violations).toEqual([])
  await view.getByRole('button', { name: 'Stop voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle')
  expect([...foreign]).toEqual([])
})
