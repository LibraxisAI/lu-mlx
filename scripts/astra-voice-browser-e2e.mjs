#!/usr/bin/env node
/**
 * Browser proof for the Astra voice loop sidecar.
 *
 * Starts the real sidecar, serves e2e/astra-voice/ from a private Vite server
 * and drives it in headless Chromium whose fake microphone plays a recorded
 * question. The page uses the real @pipecat-ai/client-js and
 * @pipecat-ai/websocket-transport, so this covers what a Python test client
 * cannot: the CORS preflight with the Authorization header, the Origin a
 * browser sends on the WebSocket, the JS protobuf serializer, the AudioWorklet
 * recorder and the SDK's own events for a tool call.
 *
 * Usage:
 *   LU_VOICE_PYTHON=<venv python> LU_VOICE_MODELS_DIR=<models> \
 *   node scripts/astra-voice-browser-e2e.mjs --wav <question.wav> \
 *     --llm-base-url http://127.0.0.1:11434/v1 --llm-model <model> [--llm-extra '{"k":"v"}'] [--browser webkit] [--csp] [--csp-script-src 'blob:']
 *
 * Chromium (the engine of WebView2) gets the WAV through its fake capture
 * device and is the reliable path. WebKit (the engine of WKWebView) has no
 * such device, so there getUserMedia is replaced by a stream that plays the
 * same WAV. That stand-in is unstable in headless WebKit: on 06.10.2026 it
 * passed 3 of 12 runs, and every failing run hung in the page's device setup
 * before the first request to the sidecar. A real WKWebView run is still owed.
 *
 * --csp serves the page under the app's own Content-Security-Policy from
 * src-tauri/tauri.conf.json. --csp-script-src adds sources to its script-src,
 * to try a policy change before it goes into the app.
 *
 * The WAV is the spoken question (16 bit PCM). It should ask for the time, the
 * page offers a get_current_time tool and answers the call like the app would.
 */

/* global window, document, AudioContext -- the page.evaluate and
   addInitScript callbacks below run IN the browser. */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { argv, env, exit } from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function args() {
  const out = { wav: null, llmBaseUrl: null, llmModel: null, llmExtra: '{}', browser: 'chromium', csp: false, cspScriptSrc: '' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--wav') out.wav = resolve(argv[++i])
    else if (a === '--llm-base-url') out.llmBaseUrl = argv[++i]
    else if (a === '--llm-model') out.llmModel = argv[++i]
    else if (a === '--llm-extra') out.llmExtra = argv[++i]
    else if (a === '--browser') out.browser = argv[++i]
    else if (a === '--csp') out.csp = true
    else if (a === '--csp-script-src') { out.csp = true; out.cspScriptSrc = argv[++i] }
  }
  if (!out.wav || !out.llmBaseUrl || !out.llmModel || !env.LU_VOICE_PYTHON || !env.LU_VOICE_MODELS_DIR) {
    console.error('Usage: LU_VOICE_PYTHON=<python> LU_VOICE_MODELS_DIR=<dir> node scripts/astra-voice-browser-e2e.mjs --wav <file> --llm-base-url <url> --llm-model <model> [--llm-extra <json>]')
    exit(2)
  }
  return out
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

// Resolves with the port once the sidecar reports its models loaded.
function startSidecar(token, origin) {
  const child = spawn(env.LU_VOICE_PYTHON, ['-m', 'lu_voice_loop', '--port', '0', '--models-dir', env.LU_VOICE_MODELS_DIR], {
    cwd: join(root, 'src-tauri/resources/voice_loop'),
    env: { ...env, LU_VOICE_TOKEN: token, LU_VOICE_ALLOWED_ORIGINS: origin },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const ready = new Promise((done, fail) => {
    let port = 0
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.startsWith('{')) return
      const event = JSON.parse(line)
      if (event.event === 'listening') port = event.port
      if (event.event === 'ready') done(port)
      if (event.event === 'fatal') fail(new Error(event.message))
    })
    child.once('exit', (code) => fail(new Error(`sidecar exited early with code ${code}`)))
  })
  return { child, ready }
}

const options = args()
const token = randomBytes(32).toString('base64url')
const pagePort = await freePort()
const origin = `http://localhost:${pagePort}`
const cacheDir = mkdtempSync(join(tmpdir(), 'astra-voice-vite-'))

// The policy goes into the page as a meta tag. Rewriting the response in the
// browser would make Chromium treat the page as coming from an unknown network
// and refuse its loopback requests, which is not what happens in the app.
function cspPlugin() {
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  let policy = config.app.security.csp
  if (options.cspScriptSrc) policy = policy.replace('script-src ', `script-src ${options.cspScriptSrc} `)
  console.log(`page CSP ${policy.split(';').find((part) => part.trim().startsWith('script-src')).trim()}`)
  return {
    name: 'astra-voice-csp',
    transformIndexHtml: (html) => html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`),
  }
}

const vite = await createServer({
  configFile: false, root, cacheDir, logLevel: 'error',
  plugins: options.csp ? [cspPlugin()] : [],
  // Bundled before the page loads. A late discovery would make Vite reload it mid run.
  optimizeDeps: { include: ['@pipecat-ai/client-js', '@pipecat-ai/websocket-transport'] },
  server: { port: pagePort, strictPort: true, host: 'localhost', hmr: false },
})
await vite.listen()
const sidecar = startSidecar(token, origin)
let browser
let failed = true
try {
  const sidecarPort = await sidecar.ready
  if (options.browser === 'webkit') {
    browser = await webkit.launch({ headless: true })
  } else {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Played once, then the fake microphone is silent.
        `--use-file-for-fake-audio-capture=${options.wav}%noloop`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
  }
  const page = await browser.newPage()
  if (options.browser === 'webkit') {
    await page.addInitScript((wavBase64) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
        const context = new AudioContext()
        const source = context.createBufferSource()
        source.buffer = await context.decodeAudioData(bytes.buffer)
        const sink = context.createMediaStreamDestination()
        source.connect(sink)
        source.start()
        return sink.stream
      }
    }, readFileSync(options.wav).toString('base64'))
  }
  // The transport package bundles Daily's SDK. Nothing in this flow may make
  // the page talk to anything but this machine.
  const foreign = new Set()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) foreign.add(url.origin)
  })
  page.on('websocket', (socket) => {
    const url = new URL(socket.url())
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) foreign.add(url.origin)
  })
  page.on('console', (message) => { if (message.type() === 'error') console.log('  [page error]', message.text()) })
  await page.goto(`${origin}/e2e/astra-voice/index.html`)
  // The page says so once its script ran and the button is wired.
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'ready', null, { timeout: 60_000 })
  await page.evaluate((opts) => { window.proofOptions = opts }, {
    endpoint: `http://127.0.0.1:${sidecarPort}/session`,
    token,
    timeoutMs: 90_000,
    config: {
      llm: { base_url: options.llmBaseUrl, model: options.llmModel, extra: JSON.parse(options.llmExtra) },
      system_prompt: 'You are a voice assistant on the user\'s computer. Your answers are spoken aloud, so reply in one or two short plain sentences without markdown. You cannot know the time by yourself: you must call the get_current_time tool and never guess.',
      tools: [{ type: 'function', function: {
        name: 'get_current_time', description: 'Returns the current local time on the user\'s computer.',
        parameters: { type: 'object', properties: {}, required: [] },
      } }],
    },
  })
  await page.click('#start')
  const result = await page.waitForFunction(() => window.proofResult, null, { timeout: 120_000, polling: 250 })
    .then((handle) => handle.jsonValue())
    .catch(async () => ({
      outcome: 'no result after 120 s', botAudioChunks: 0, toolCalls: 0,
      events: await page.evaluate(() => window.proofTrace ?? []),
    }))

  for (const event of result.events) console.log(`${String(event.t).padStart(7)} ms  ${event.name}${event.detail ? '  ' + JSON.stringify(event.detail) : ''}`)
  const at = (name) => result.events.find((event) => event.name === name)?.t
  const stopped = at('user-stopped-speaking')
  const audio = at('first-bot-audio')
  console.log(`\noutcome: ${result.outcome}, tool calls: ${result.toolCalls}, bot audio chunks: ${result.botAudioChunks}`)
  if (stopped !== undefined && audio !== undefined) console.log(`user-stopped-speaking -> first bot audio in the page: ${audio - stopped} ms`)
  const errors = result.events.filter((event) => event.name === 'error')
  console.log(`requests to other hosts: ${foreign.size ? [...foreign].join(', ') : 'none'}`)
  failed = result.outcome !== 'answered' || result.toolCalls < 1 || result.botAudioChunks < 1 || errors.length > 0 || foreign.size > 0
} finally {
  await browser?.close()
  await vite.close()
  rmSync(cacheDir, { recursive: true, force: true })
  // Closing stdin is how the app stops the sidecar.
  sidecar.child.stdin.end()
  const code = await new Promise((done) => {
    if (sidecar.child.exitCode !== null) done(sidecar.child.exitCode)
    else sidecar.child.once('exit', done)
  })
  console.log(`sidecar exit code after stdin close: ${code}`)
  if (code !== 0) failed = true
}
console.log(failed ? 'FAILED' : 'PASSED')
exit(failed ? 1 : 0)
