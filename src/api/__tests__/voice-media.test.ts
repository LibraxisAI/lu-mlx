// The media manager against a fake audio context: what reaches the voice
// loop of the microphone before and after the connection, the settle tone on
// the output, and the silence around the start of the first answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LuVoiceMediaManager } from '../voice-media'
import { renderStartSound, START_SOUND_PEAK } from '../../lib/voice/start-sound'
import { FIRST_SPEECH_GUARD_SECS, HELD_MIC_SECS, SETTLE_TONE_GAIN, SETTLE_TONE_HZ, SETTLE_TONE_SECS } from '../../lib/voice/mic-start'

interface FakeParam { value: number; events: Array<[string, number, number]>; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }
function param(value: number): FakeParam {
  return {
    value, events: [],
    setValueAtTime(v, t) { this.events.push(['set', v, t]) },
    linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]) },
  }
}
class FakeNode {
  to: unknown[] = []
  connect(node: unknown) { this.to.push(node) }
  disconnect() { this.to = [] }
}
class FakeOscillator extends FakeNode {
  frequency = param(440)
  startedAt: number | null = null
  stopAt: number | null = null
  onended: (() => void) | null = null
  start(at: number) { this.startedAt = at }
  stop(at?: number) { this.stopAt = at ?? -1 }
}
class FakeGain extends FakeNode { gain = param(1) }
class FakeScript extends FakeNode { onaudioprocess: ((event: { inputBuffer: { getChannelData(i: number): Float32Array } }) => void) | null = null }
class FakeBufferSource extends FakeNode {
  buffer: unknown = null
  onended: (() => void) | null = null
  startedAt: number | null = null
  start(at: number) { this.startedAt = at }
  stopped = false
  stop() { this.stopped = true }
}

let contexts: FakeContext[] = []
class FakeContext {
  sampleRate = 16_000
  currentTime = 0
  state = 'running'
  outputLatency = 0
  baseLatency = 0
  destination = new FakeNode()
  oscillators: FakeOscillator[] = []
  gains: FakeGain[] = []
  scripts: FakeScript[] = []
  sources: FakeBufferSource[] = []
  constructor() { contexts.push(this) }
  resume() { return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node }
  createAnalyser() { return Object.assign(new FakeNode(), { fftSize: 0, getFloatTimeDomainData() {} }) }
  createOscillator() { const node = new FakeOscillator(); this.oscillators.push(node); return node }
  createMediaStreamSource() { return new FakeNode() }
  createScriptProcessor() { const node = new FakeScript(); this.scripts.push(node); return node }
  createBuffer(_channels: number, length: number, rate: number) { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data } }
  createBufferSource() { const node = new FakeBufferSource(); this.sources.push(node); return node }
}

function fakeStream() {
  const track = { enabled: true, label: 'Fake microphone', stop: vi.fn(), addEventListener: vi.fn(), getSettings: () => ({ deviceId: 'mic-1' }) }
  return { getTracks: () => [track], getAudioTracks: () => [track] }
}

/** One block of microphone at the context rate, loud everywhere. */
function speak(context: FakeContext, value = 0.5, samples = 512) {
  const block = new Float32Array(samples).fill(value)
  context.scripts.at(-1)!.onaudioprocess!({ inputBuffer: { getChannelData: () => block } })
}

async function opened(options: ConstructorParameters<typeof LuVoiceMediaManager>[0] = {}) {
  const media = new LuVoiceMediaManager(options)
  const sent: Int16Array[] = []
  media.setUserAudioCallback((data) => sent.push(new Int16Array(data)))
  await media.initialize()
  return { media, sent, context: contexts.at(-1)! }
}

beforeEach(() => {
  vi.useFakeTimers()
  contexts = []
  vi.stubGlobal('window', { AudioContext: FakeContext })
  vi.stubGlobal('document', { baseURI: 'http://localhost/' })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => fakeStream()), enumerateDevices: vi.fn(async () => []), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the microphone before the voice loop is connected', () => {
  it('is held, and goes out first and in order once the session is up', async () => {
    const { media, sent, context } = await opened()
    speak(context, 0.25); speak(context, 0.5)
    await media.connect()
    // The socket is open, the voice loop has not answered yet: still held.
    speak(context, 0.6)
    expect(sent).toHaveLength(0)
    media.sendHeld()
    // The first step sends one chunk, the rest follows in steps.
    expect(sent).toHaveLength(1)
    speak(context, 0.75)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(sent.map((chunk) => chunk[0])).toEqual([0.25, 0.5, 0.6, 0.75].map((value) => Math.round(value * 32767)))
    // Caught up: every block goes straight out, and nothing is sent twice.
    speak(context, 0.9)
    expect(sent).toHaveLength(5)
    media.sendHeld()
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toHaveLength(5)
    await media.disconnect()
  })

  it('holds a minute at most, and sends it faster than real time but not at once', async () => {
    const { media, sent, context } = await opened()
    const blocksPerSecond = 16_000 / 512
    for (let i = 0; i < Math.ceil(blocksPerSecond * (HELD_MIC_SECS + 20)); i++) speak(context)
    await media.connect()
    media.sendHeld()
    const all = Math.ceil(HELD_MIC_SECS * blocksPerSecond)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.length).toBeGreaterThan(blocksPerSecond * 4)
    expect(sent.length).toBeLessThan(all / 2)
    await vi.advanceTimersByTimeAsync(8000)
    expect(sent.length).toBe(all)
    await media.disconnect()
  })

  it('holds nothing for a session that starts muted, and drops what it held on mute', async () => {
    const muted = await opened({ micEnabled: false })
    speak(muted.context)
    await muted.media.connect()
    muted.media.sendHeld()
    await vi.advanceTimersByTimeAsync(100)
    expect(muted.sent).toHaveLength(0)
    await muted.media.disconnect()

    const { media, sent, context } = await opened()
    speak(context)
    media.enableMic(false)
    media.enableMic(true)
    await media.connect()
    media.sendHeld()
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toHaveLength(0)
    await media.disconnect()
  })

  it('a session that is stopped while it catches up sends nothing more', async () => {
    const { media, sent, context } = await opened()
    for (let i = 0; i < 200; i++) speak(context)
    await media.connect()
    media.sendHeld()
    await media.disconnect()
    const before = sent.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.length).toBe(before)
    expect(before).toBeLessThan(200)
  })
})

describe('the settle tone', () => {
  it('plays on the output from the moment the microphone is open, fades, and ends', async () => {
    const { media, context } = await opened()
    expect(context.oscillators).toHaveLength(1)
    const tone = context.oscillators[0]
    expect(tone.frequency.value).toBe(SETTLE_TONE_HZ)
    expect(tone.startedAt).toBe(0)
    expect(tone.stopAt).toBe(SETTLE_TONE_SECS)
    const level = tone.to[0] as FakeGain
    expect(level.to[0]).toBe(context.destination)
    expect(level.gain.events[0]).toEqual(['set', 0, 0])
    expect(Math.max(...level.gain.events.map((event) => event[1]))).toBe(SETTLE_TONE_GAIN)
    expect(level.gain.events.at(-1)).toEqual(['ramp', 0, SETTLE_TONE_SECS])
    tone.onended?.()
    expect(tone.to).toHaveLength(0)
    await media.disconnect()
  })

  it('plays again for another microphone, and stops with the session', async () => {
    const { media, context } = await opened()
    await media.updateMic('mic-2')
    expect(context.oscillators).toHaveLength(2)
    expect(context.oscillators[0].stopAt).toBe(-1)
    await media.disconnect()
    expect(context.oscillators[1].stopAt).toBe(-1)
  })
})

describe('the start sound', () => {
  it('is the rendered chord, played once on the device and not through the level display', async () => {
    const { media, context } = await opened()
    context.currentTime = 3
    media.playStartSound()
    media.playStartSound()
    expect(context.sources).toHaveLength(1)
    const node = context.sources[0]
    expect(node.to).toEqual([context.destination])
    expect(node.startedAt).toBeCloseTo(3.02)
    const played = (node.buffer as { getChannelData(): Float32Array }).getChannelData()
    expect(Array.from(played)).toEqual(Array.from(renderStartSound(context.sampleRate)))
    expect(Math.max(...played.map(Math.abs))).toBeLessThanOrEqual(START_SOUND_PEAK + 1e-6)
    node.onended?.()
    expect(node.to).toHaveLength(0)
    await media.disconnect()
  })

  it('does not count as the first answer: the guard still waits for speech', async () => {
    const { media, sent, context } = await opened()
    await media.connect()
    media.sendHeld()
    media.playStartSound()
    context.currentTime = 0.1
    speak(context)
    vi.advanceTimersByTime(50)
    expect(sent.some((chunk) => chunk.some((sample) => sample !== 0))).toBe(true)
    await media.disconnect()
  })

  it('stops with the session', async () => {
    const { media, context } = await opened()
    media.playStartSound()
    await media.disconnect()
    expect(context.sources[0].stopped).toBe(true)
    expect(context.sources[0].to).toHaveLength(0)
  })
})

describe('the start of the first answer', () => {
  it('reaches the voice loop as silence, the rest of the answer and every later one as they are', async () => {
    const { media, sent, context } = await opened()
    await media.connect()
    media.sendHeld()
    const loud = (chunk: Int16Array) => chunk.some((sample) => sample !== 0)
    context.currentTime = 8
    speak(context)
    expect(loud(sent.at(-1)!)).toBe(true)

    media.bufferBotAudio(new Int16Array(2400).fill(1000))
    const startsAt = context.sources[0].startedAt!
    context.currentTime = startsAt + 0.25
    speak(context)
    expect(loud(sent.at(-1)!)).toBe(false)
    expect(media.levels().mic).toBe(0)
    context.currentTime = startsAt + FIRST_SPEECH_GUARD_SECS + 0.01
    speak(context)
    expect(loud(sent.at(-1)!)).toBe(true)

    // The second answer: the user is heard from its first instant.
    media.interrupt()
    context.currentTime = 30
    media.bufferBotAudio(new Int16Array(2400).fill(1000))
    context.currentTime = context.sources[1].startedAt! + 0.1
    speak(context)
    expect(loud(sent.at(-1)!)).toBe(true)
    await media.disconnect()
  })
})
