// Microphone and speaker of a voice session.
//
// This is the media manager the Pipecat WebSocket transport talks to. The
// transport ships two of its own. Neither works in this app:
//
//   - Both load their AudioWorklet code from a blob: URL. The app's
//     Content-Security-Policy is `script-src 'self' 'wasm-unsafe-eval'`, so
//     the webview refuses those modules and no audio flows.
//   - Their recorder awaits `AudioContext.resume()` after the microphone
//     prompt. WebKit only starts an AudioContext while the click that asked
//     for it is still fresh, and a resume() outside of it never settles.
//     That is the device setup hang seen in WebKit.
//
// So this one keeps the policy as it is and is built around the click:
//
//   - One AudioContext, created and resumed synchronously in `initialize()`,
//     which the surface calls straight from the Start click. Nothing ever
//     waits for resume().
//   - Capture through an AudioWorklet whose module is a file of this app
//     (public/voice/capture-worklet.js, served from 'self'). When a webview
//     cannot load it, a ScriptProcessor does the same job on the main thread.
//   - Playback without any worklet: speech arrives as 24 kHz PCM, is
//     resampled to the device rate and scheduled back to back on the context
//     clock. Interrupting stops every scheduled piece at once.
//
// The echo cancellation of the webview is what keeps the assistant from
// hearing itself, which is why microphone and speaker both live here and not
// in the voice loop process. It needs a few seconds of played sound before it
// lets a voice through while the assistant talks, so every microphone that is
// opened gets a tone nobody hears (lib/voice/mic-start.ts).
//
// The microphone is open before the voice loop is connected. What is said in
// that time is held, up to a minute, and sent once the session is up
// (`sendHeld`), faster than real time but not in one burst.

import type { PipecatClientOptions, Tracks } from '@pipecat-ai/client-js'
import { openMicrophone } from './microphone'
import {
  FirstSpeechGuard, HELD_MIC_SECS, HeldAudio, SETTLE_TONE_FADE_SECS, SETTLE_TONE_GAIN, SETTLE_TONE_HZ, SETTLE_TONE_SECS,
  heldChunksDue,
} from '../lib/voice/mic-start'
import { renderStartSound } from '../lib/voice/start-sound'
import { Int16Chunker, StreamResampler, floatToInt16, int16ToFloat, rms } from '../lib/voice/resample'

export type VoiceMicErrorKind = 'denied' | 'missing' | 'busy' | 'unsupported' | 'unknown'

export class VoiceMicError extends Error {
  readonly kind: VoiceMicErrorKind
  constructor(kind: VoiceMicErrorKind, message: string) {
    super(message)
    this.name = 'VoiceMicError'
    this.kind = kind
  }
}

/** Sort a getUserMedia failure into what the user can do about it. */
export function classifyMicError(error: unknown): VoiceMicError {
  if (error instanceof VoiceMicError) return error
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new VoiceMicError('denied', 'The microphone is blocked for this app.')
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return new VoiceMicError('missing', 'No microphone was found.')
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return new VoiceMicError('busy', 'The microphone could not be opened. Another app may be using it.')
  }
  return new VoiceMicError('unknown', 'The microphone could not be opened.')
}

export interface VoiceMediaOptions {
  /** Preferred microphone. Falls back to the default when it is gone. */
  micId?: string | null
  /** False for a session that starts muted: nothing is kept or sent until it is unmuted. */
  micEnabled?: boolean
  /** Rate the voice loop expects from the microphone. */
  inputRate?: number
  /** Rate of the speech the voice loop sends. */
  outputRate?: number
  /** Samples per microphone message. 512 at 16 kHz is 32 ms. */
  chunkSamples?: number
  /** Where the capture worklet module lives. */
  workletUrl?: string
}

type AudioCallback = (data: ArrayBuffer) => void

interface CaptureHandle {
  stop(): void
}

const CAPTURE_PROCESSOR = 'lu-voice-capture'
/** How often held microphone audio is passed on while a session catches up. */
const HELD_STEP_MS = 20

function workletModuleUrl(): string {
  // Relative to the document, so it resolves under tauri://localhost, under
  // http://tauri.localhost and under the dev server alike.
  return new URL('voice/capture-worklet.js', document.baseURI).href
}

export class LuVoiceMediaManager {
  private readonly inputRate: number
  private readonly outputRate: number
  private readonly chunkSamples: number
  private readonly workletUrl: string | undefined

  private callbacks: NonNullable<PipecatClientOptions['callbacks']> = {}
  private userAudio: AudioCallback | null = null
  private micEnabled = true
  private micId: string | null

  private ready: Promise<void> | null = null
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private capture: CaptureHandle | null = null
  private workletLoaded = false
  private workletFailed = false
  private output: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer: Float32Array<ArrayBuffer> | null = null

  private down: StreamResampler | null = null
  private up: StreamResampler | null = null
  private chunker: Int16Chunker
  private micLevel = 0

  private readonly playing = new Set<AudioBufferSourceNode>()
  private playHead = 0
  /** The microphone goes straight to the voice loop. Before that it is held. */
  private sending = false
  private held: HeldAudio
  private catchUp: ReturnType<typeof setTimeout> | null = null
  private readonly guard = new FirstSpeechGuard()
  private settling: { stop(): void } | null = null
  private startSound: AudioBufferSourceNode | null = null
  private readonly onDeviceChange = () => { void this.devicesChanged() }

  /** How the microphone reaches the page: 'worklet', or 'script' as fallback. */
  captureMode: 'worklet' | 'script' | null = null

  constructor(options: VoiceMediaOptions = {}) {
    this.inputRate = options.inputRate ?? 16_000
    this.outputRate = options.outputRate ?? 24_000
    this.chunkSamples = options.chunkSamples ?? 512
    this.workletUrl = options.workletUrl
    this.micId = options.micId || null
    this.micEnabled = options.micEnabled ?? true
    this.chunker = new Int16Chunker(this.chunkSamples)
    this.held = HeldAudio.forSeconds(HELD_MIC_SECS, this.inputRate, this.chunkSamples)
  }

  // ---- contract of the transport ---------------------------------------

  readonly supportsScreenShare = false

  setUserAudioCallback(callback: AudioCallback): void {
    this.userAudio = callback
  }

  setClientOptions(options: PipecatClientOptions, override = false): void {
    if (this.clientOptionsSet && !override) return
    this.clientOptionsSet = true
    this.callbacks = options.callbacks ?? {}
    this.micEnabled = options.enableMic ?? true
  }
  private clientOptionsSet = false

  /**
   * Open the audio context and the microphone. Call this directly from the
   * click that starts the session: both need the user gesture in WebKit.
   * Safe to call again, a second call returns the first one's result.
   */
  initialize(): Promise<void> {
    this.ready ??= this.open().catch((error) => {
      this.ready = null
      this.release()
      throw classifyMicError(error)
    })
    return this.ready
  }

  /** The transport calls this once the WebSocket is open. */
  async connect(): Promise<void> {
    await this.initialize()
    // A context that was created outside a gesture may still be suspended.
    // Ask again, but never wait for the answer.
    if (this.context?.state === 'suspended') void this.context.resume().catch(() => {})
    this.applyMicEnabled()
  }

  /**
   * The session is up: send what the microphone delivered since it was
   * opened, then everything as it comes. The session calls this when the
   * voice loop has answered, not earlier, because the transport would pass
   * on whatever it got before that in one burst.
   */
  sendHeld(): void {
    if (this.sending || this.catchUp || !this.context) return
    let last = performance.now()
    const step = () => {
      this.catchUp = null
      const now = performance.now()
      const due = heldChunksDue((now - last) / 1000, this.inputRate, this.chunkSamples)
      last = now
      for (const chunk of this.held.take(due)) this.userAudio?.(chunk.buffer as ArrayBuffer)
      if (this.held.length === 0) this.sending = true
      else this.catchUp = setTimeout(step, HELD_STEP_MS)
    }
    step()
  }

  async disconnect(): Promise<void> {
    this.sending = false
    this.ready = null
    this.release()
  }

  /** The user started talking: whatever is still queued must not be heard. */
  async userStartedSpeaking(): Promise<void> {
    this.interrupt()
  }

  bufferBotAudio(data: ArrayBuffer | Int16Array): void {
    const context = this.context
    const output = this.output
    if (!context || !output || !this.up) return
    const pcm = data instanceof Int16Array ? data : new Int16Array(data)
    if (pcm.length === 0) return
    const samples = this.up.push(int16ToFloat(pcm))
    if (samples.length === 0) return
    const buffer = context.createBuffer(1, samples.length, context.sampleRate)
    buffer.getChannelData(0).set(samples)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(output)
    // A small lead on an empty queue absorbs the jitter of the first chunks.
    const now = context.currentTime
    if (this.playHead < now + 0.01) {
      this.playHead = now + 0.04
      this.guard.speechStarts(this.playHead, (context.outputLatency || 0) + (context.baseLatency || 0))
    }
    node.start(this.playHead)
    this.playHead += buffer.duration
    this.playing.add(node)
    node.onended = () => {
      this.playing.delete(node)
      node.disconnect()
    }
  }

  /** Drop every piece of speech that is playing or queued, right now. */
  interrupt(): void {
    for (const node of this.playing) {
      node.onended = null
      try { node.stop() } catch { /* not started yet or already over */ }
      node.disconnect()
    }
    this.playing.clear()
    this.playHead = 0
    this.up?.reset()
  }

  /** Seconds of speech that are still queued for the speaker. */
  get queuedSeconds(): number {
    const context = this.context
    if (!context) return 0
    return Math.max(0, this.playHead - context.currentTime)
  }

  async getAllMics(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((device) => device.kind === 'audioinput')
  }

  getAllCams(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve([])
  }

  getAllSpeakers(): Promise<MediaDeviceInfo[]> {
    return Promise.resolve([])
  }

  /** Switch the microphone. An empty id means the system default. */
  async updateMic(micId: string): Promise<void> {
    this.micId = micId || null
    if (!this.context || !this.ready) return
    const previous = this.stream
    let stream: MediaStream
    try {
      stream = await this.openStream(this.micId)
    } catch (error) {
      throw classifyMicError(error)
    }
    this.detachCapture()
    previous?.getTracks().forEach((track) => track.stop())
    await this.attach(stream)
    this.applyMicEnabled()
    const selected = this.selectedMic
    if ('deviceId' in selected) this.callbacks.onMicUpdated?.(selected as MediaDeviceInfo)
  }

  updateCam(): void {}
  updateSpeaker(): void {}

  get selectedMic(): MediaDeviceInfo | Record<string, never> {
    const track = this.stream?.getAudioTracks()[0]
    if (!track) return {}
    const settings = track.getSettings()
    return {
      deviceId: settings.deviceId ?? this.micId ?? '',
      groupId: settings.groupId ?? '',
      kind: 'audioinput',
      label: track.label,
      toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label } },
    } as MediaDeviceInfo
  }

  get selectedCam(): Record<string, never> { return {} }
  get selectedSpeaker(): Record<string, never> { return {} }

  enableMic(enable: boolean): void {
    this.micEnabled = enable
    this.applyMicEnabled()
  }

  enableCam(): void {}
  enableScreenShare(): void {}

  get isMicEnabled(): boolean { return this.micEnabled }
  get isCamEnabled(): boolean { return false }
  get isSharingScreen(): boolean { return false }

  tracks(): Tracks {
    const audio = this.stream?.getAudioTracks()[0]
    return { local: audio ? { audio } : {} }
  }

  // ---- for the surface -------------------------------------------------

  /** Loudness of the microphone and of the answer, 0 to 1, for the display. */
  levels(): { mic: number; bot: number } {
    let bot = 0
    if (this.analyser && this.levelBuffer && this.playing.size > 0) {
      this.analyser.getFloatTimeDomainData(this.levelBuffer)
      bot = rms(this.levelBuffer)
    }
    return { mic: this.micEnabled ? this.micLevel : 0, bot }
  }

  // ---- internals -------------------------------------------------------

  private async open(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new VoiceMicError('unsupported', 'This window cannot access a microphone.')
    }
    const Context: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) throw new VoiceMicError('unsupported', 'This window cannot play audio.')

    // Everything up to the first await runs inside the user's click.
    const context = new Context({ latencyHint: 'interactive' })
    this.context = context
    void context.resume().catch(() => {})
    const opening = this.openStream(this.micId)

    const output = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    output.connect(analyser)
    analyser.connect(context.destination)
    this.output = output
    this.analyser = analyser
    this.levelBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
    this.down = new StreamResampler(context.sampleRate, this.inputRate)
    this.up = new StreamResampler(this.outputRate, context.sampleRate)

    const stream = await opening
    // The session may have been stopped while the permission prompt was up.
    if (this.context !== context) {
      stream.getTracks().forEach((track) => track.stop())
      throw new VoiceMicError('unknown', 'The session was stopped.')
    }
    await this.attach(stream)
    navigator.mediaDevices.addEventListener?.('devicechange', this.onDeviceChange)
  }

  private openStream(micId: string | null): Promise<MediaStream> {
    return openMicrophone({
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }, micId)
  }

  private async attach(stream: MediaStream): Promise<void> {
    const context = this.context
    if (!context) return
    this.stream = stream
    this.source = context.createMediaStreamSource(stream)
    this.down?.reset()
    this.chunker.reset()
    this.capture = (await this.workletCapture(context, this.source)) ?? this.scriptCapture(context, this.source)
    // Each microphone track has its own echo cancellation, which starts cold.
    this.settle(context)
    const track = stream.getAudioTracks()[0]
    if (track) {
      track.addEventListener('ended', () => {
        // The device was unplugged. Fall back to the default microphone.
        if (this.stream === stream) void this.updateMic('').catch(() => {})
      })
    }
  }

  private async workletCapture(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<CaptureHandle | null> {
    if (this.workletFailed || !context.audioWorklet || typeof AudioWorkletNode === 'undefined') return null
    try {
      if (!this.workletLoaded) {
        await context.audioWorklet.addModule(this.workletUrl ?? workletModuleUrl())
        this.workletLoaded = true
      }
      const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit',
      })
      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onSamples(event.data)
      source.connect(node)
      this.captureMode = 'worklet'
      return {
        stop: () => {
          node.port.onmessage = null
          try { source.disconnect(node) } catch { /* already disconnected */ }
        },
      }
    } catch {
      // A webview that cannot load the module still gets a working microphone.
      this.workletFailed = true
      return null
    }
  }

  private scriptCapture(context: AudioContext, source: MediaStreamAudioSourceNode): CaptureHandle {
    const node = context.createScriptProcessor(2048, 1, 1)
    // A ScriptProcessor only runs while it leads somewhere. The gain keeps
    // the microphone out of the speaker.
    const silent = context.createGain()
    silent.gain.value = 0
    node.onaudioprocess = (event) => this.onSamples(event.inputBuffer.getChannelData(0))
    source.connect(node)
    node.connect(silent)
    silent.connect(context.destination)
    this.captureMode = 'script'
    return {
      stop: () => {
        node.onaudioprocess = null
        try { source.disconnect(node) } catch { /* already disconnected */ }
        node.disconnect()
        silent.disconnect()
      },
    }
  }

  /**
   * Play the sound that says the session is listening (lib/voice/start-sound.ts).
   * Straight to the device, like the settle tone: it is not the assistant
   * speaking, so neither the level display nor the guard of the first answer
   * takes it for speech.
   */
  playStartSound(): void {
    const context = this.context
    if (!context || this.startSound) return
    const samples = renderStartSound(context.sampleRate)
    const buffer = context.createBuffer(1, samples.length, context.sampleRate)
    buffer.getChannelData(0).set(samples)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    node.onended = () => {
      node.disconnect()
      if (this.startSound === node) this.startSound = null
    }
    node.start(context.currentTime + 0.02)
    this.startSound = node
  }

  /**
   * Play the tone that lets the echo cancellation settle before the first
   * answer, and guard the start of that answer (lib/voice/mic-start.ts).
   */
  private settle(context: AudioContext): void {
    this.settling?.stop()
    this.settling = null
    if (typeof context.createOscillator !== 'function') return
    const tone = context.createOscillator()
    const level = context.createGain()
    const from = context.currentTime
    const to = from + SETTLE_TONE_SECS
    tone.frequency.value = SETTLE_TONE_HZ
    level.gain.setValueAtTime(0, from)
    level.gain.linearRampToValueAtTime(SETTLE_TONE_GAIN, from + SETTLE_TONE_FADE_SECS)
    level.gain.setValueAtTime(SETTLE_TONE_GAIN, to - SETTLE_TONE_FADE_SECS)
    level.gain.linearRampToValueAtTime(0, to)
    // Straight to the device: the answer's level display must not see it.
    tone.connect(level)
    level.connect(context.destination)
    const handle = {
      stop: () => {
        tone.onended = null
        try { tone.stop() } catch { /* already over */ }
        tone.disconnect()
        level.disconnect()
      },
    }
    tone.onended = () => {
      handle.stop()
      if (this.settling === handle) this.settling = null
    }
    tone.start(from)
    tone.stop(to)
    this.settling = handle
    this.guard.arm()
  }

  private onSamples(block: Float32Array): void {
    if (!this.down) return
    if (this.context && this.guard.silences(this.context.currentTime)) block = new Float32Array(block.length)
    this.micLevel = rms(block)
    if (!this.micEnabled) return
    const chunks = this.chunker.push(floatToInt16(this.down.push(block)))
    if (this.sending && this.userAudio) {
      for (const chunk of chunks) this.userAudio(chunk.buffer as ArrayBuffer)
    } else {
      for (const chunk of chunks) this.held.push(chunk)
    }
  }

  private applyMicEnabled(): void {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = this.micEnabled })
    if (!this.micEnabled) {
      this.chunker.reset()
      this.held.clear()
      this.micLevel = 0
    }
  }

  private async devicesChanged(): Promise<void> {
    const mics = await this.getAllMics().catch(() => [] as MediaDeviceInfo[])
    this.callbacks.onAvailableMicsUpdated?.(mics)
  }

  private detachCapture(): void {
    this.capture?.stop()
    this.capture = null
    try { this.source?.disconnect() } catch { /* already disconnected */ }
    this.source = null
  }

  private release(): void {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange)
    this.interrupt()
    this.settling?.stop()
    this.settling = null
    if (this.startSound) {
      this.startSound.onended = null
      try { this.startSound.stop() } catch { /* already over */ }
      this.startSound.disconnect()
      this.startSound = null
    }
    this.guard.reset()
    if (this.catchUp) clearTimeout(this.catchUp)
    this.catchUp = null
    this.held.clear()
    this.detachCapture()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    const context = this.context
    this.context = null
    this.output = null
    this.analyser = null
    this.levelBuffer = null
    this.down = null
    this.up = null
    this.workletLoaded = false
    this.micLevel = 0
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }
}
