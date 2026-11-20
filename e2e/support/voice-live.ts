import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/**
 * A real voice loop and a spoken question for the live voice specs.
 *
 * The sidecar is the one in src-tauri/resources/voice_loop, run by the Python
 * of LU_VOICE_PYTHON against the models in LU_VOICE_MODELS_DIR, exactly as
 * the app starts it: token in the environment, port chosen by the process,
 * stopped by closing stdin.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const LIVE = {
  python: process.env.LU_VOICE_PYTHON ?? '',
  modelsDir: process.env.LU_VOICE_MODELS_DIR ?? '',
  /** An Ollama tag on this machine, for example hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M. */
  llmModel: process.env.LU_VOICE_LLM_MODEL ?? '',
}
export const LIVE_READY = Boolean(LIVE.python && LIVE.modelsDir && LIVE.llmModel)

/**
 * Load the local model into Ollama before a session starts, the way it is
 * loaded for a user who has just chatted with it.
 *
 * A spec that plays one recording on a fixed timeline needs this: the
 * recording starts at the click on Start, and with a model that still has to
 * be loaded the session is up later and its first answer comes later, so the
 * sentence that should interrupt the answer is spoken before there is one
 * (voice-barge-in-live.spec.ts, red in 1 of 10 runs right after another
 * model had been used, 08.10.2026). A cold start is its own spec:
 * voice-cold-start-live.spec.ts.
 */
export async function warmLocalModel(baseUrl = 'http://localhost:11434'): Promise<void> {
  const answer = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LIVE.llmModel, prompt: 'Say hi.', stream: false, options: { num_predict: 1 } }),
  })
  if (!answer.ok) throw new Error(`Ollama did not load ${LIVE.llmModel}: HTTP ${answer.status}`)
  await answer.arrayBuffer()
}

export interface LiveSidecar {
  port: number
  token: string
  stop: () => Promise<number | null>
}

export async function startSidecar(origin: string): Promise<LiveSidecar> {
  const token = randomBytes(32).toString('base64url')
  const child: ChildProcess = spawn(LIVE.python, ['-m', 'lu_voice_loop', '--port', '0', '--models-dir', LIVE.modelsDir], {
    cwd: join(root, 'src-tauri/resources/voice_loop'),
    env: { ...process.env, LU_VOICE_TOKEN: token, LU_VOICE_ALLOWED_ORIGINS: origin },
    // LU_VOICE_SIDECAR_LOG=<file> keeps what the voice loop logs, for debugging a run.
    stdio: ['pipe', 'pipe', process.env.LU_VOICE_SIDECAR_LOG ? openSync(process.env.LU_VOICE_SIDECAR_LOG, 'a') : 'ignore'],
  })
  const port = await new Promise<number>((done, fail) => {
    let listening = 0
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.startsWith('{')) return
      const event = JSON.parse(line) as { event?: string; port?: number; message?: string }
      if (event.event === 'listening') listening = event.port ?? 0
      if (event.event === 'ready') done(listening)
      if (event.event === 'fatal') fail(new Error(event.message))
    })
    child.once('exit', (code) => fail(new Error(`The voice loop exited early with code ${code}.`)))
  })
  return {
    port,
    token,
    stop: () => new Promise((done) => {
      if (child.exitCode !== null) { done(child.exitCode); return }
      child.once('exit', (code) => done(code))
      child.stdin?.end()
    }),
  }
}

function wavData(file: Buffer): { rate: number; pcm: Buffer } {
  let at = 12
  let rate = 0
  while (at + 8 <= file.length) {
    const id = file.toString('ascii', at, at + 4)
    const size = file.readUInt32LE(at + 4)
    if (id === 'fmt ') rate = file.readUInt32LE(at + 12)
    if (id === 'data') return { rate, pcm: file.subarray(at + 8, at + 8 + size) }
    at += 8 + size + (size % 2)
  }
  throw new Error('Not a PCM WAV file.')
}

/**
 * A 48 kHz mono WAV: silence, the sentence spoken by the system voice, more
 * silence. The lead of silence is there because the fake microphone starts
 * playing the moment it is opened, which is before the session is connected.
 */
function wavFile(rate: number, body: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + body.length, 4); header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii'); header.writeUInt32LE(body.length, 40)
  return Buffer.concat([header, body])
}

export function spokenQuestion(text: string, leadSecs = 4, tailSecs = 3, voice = 'Samantha'): string {
  const dir = join(tmpdir(), 'lu-voice-e2e')
  mkdirSync(dir, { recursive: true })
  const name = `${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}${voice === 'Samantha' ? '' : `-${voice.toLowerCase()}`}`
  const out = join(dir, `${name}-${leadSecs}-${tailSecs}.wav`)
  if (existsSync(out)) return out
  const aiff = join(dir, `${name}.aiff`)
  const speech = join(dir, `${name}-speech.wav`)
  execFileSync('say', ['-v', voice, '-o', aiff, text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, speech])
  const { rate, pcm } = wavData(readFileSync(speech))
  writeFileSync(out, wavFile(rate, Buffer.concat([Buffer.alloc(rate * 2 * leadSecs), pcm, Buffer.alloc(rate * 2 * tailSecs)])))
  return out
}
export interface SpokenLine { text: string; startSecs: number; endSecs: number }

/**
 * A 48 kHz mono WAV with several sentences: `leadSecs` of silence, then each
 * sentence followed by its own pause. Returns the file and when each sentence
 * starts and ends, counted from the start of the file.
 */
export function spokenScript(lines: Array<{ text: string; pauseSecs: number; voice?: string }>, leadSecs: number): { file: string; lines: SpokenLine[] } {
  const dir = join(tmpdir(), 'lu-voice-e2e')
  mkdirSync(dir, { recursive: true })
  const parts: Buffer[] = []
  const spoken: SpokenLine[] = []
  let rate = 48_000
  let at = leadSecs
  for (const line of lines) {
    const clip = wavData(readFileSync(spokenQuestion(line.text, 0, 0, line.voice)))
    rate = clip.rate
    const secs = clip.pcm.length / 2 / rate
    spoken.push({ text: line.text, startSecs: at, endSecs: at + secs })
    parts.push(clip.pcm, Buffer.alloc(Math.round(rate * line.pauseSecs) * 2))
    at += secs + line.pauseSecs
  }
  const name = lines.map((line) => `${line.text}${line.pauseSecs}${line.voice ?? ''}`).join('|').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 96)
  const file = join(dir, `script-${name}-${leadSecs}.wav`)
  writeFileSync(file, wavFile(rate, Buffer.concat([Buffer.alloc(rate * 2 * leadSecs), ...parts])))
  return { file, lines: spoken }
}

/**
 * WebKit only: a microphone that plays the recording. The context is created
 * while the page loads and resumed inside getUserMedia, which the app calls
 * from the Start click, so WebKit lets it run.
 */
export function fakeMicInit(wavBase64: string) {
  const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
  // The machine that runs the test stays silent. Headless Chromium is muted
  // by Playwright; WebKit is not, so here everything on its way to the
  // speakers passes a closed gate. Playback is scheduled and counted as before.
  const gates = new WeakMap<BaseAudioContext, GainNode>()
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const target = args[0]
    if (!(target instanceof AudioDestinationNode)) return connect.apply(this, args)
    let gate = gates.get(this.context)
    if (!gate) {
      gate = this.context.createGain()
      gate.gain.value = 0
      connect.call(gate, target)
      gates.set(this.context, gate)
    }
    return connect.call(this, gate)
  } as typeof AudioNode.prototype.connect
  const context = new AudioContext()
  const decoded = context.decodeAudioData(bytes.buffer)
  // On the prototype: WebKit can drop a property set on the object itself.
  MediaDevices.prototype.getUserMedia = async () => {
    void context.resume()
    const source = context.createBufferSource()
    const sink = context.createMediaStreamDestination()
    source.connect(sink)
    void decoded.then((buffer) => {
      source.buffer = buffer
      source.start()
    })
    return sink.stream
  }
  MediaDevices.prototype.enumerateDevices = async () => [
    { deviceId: 'recording', groupId: 'e2e', kind: 'audioinput', label: 'Recorded question', toJSON: () => ({}) } as MediaDeviceInfo,
  ]
}
