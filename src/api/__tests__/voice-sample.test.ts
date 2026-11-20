/**
 * @vitest-environment jsdom
 *
 * Hearing a voice in the voice settings: the engine is asked for one fixed
 * sentence in one named voice, and whatever goes wrong arrives as a sentence.
 *
 * Run: npx vitest run src/api/__tests__/voice-sample.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  active: false,
  startError: null as unknown,
  uses: 0,
}))
vi.mock('../voice-session', () => ({
  voiceSessionActive: () => engine.active,
  withVoiceEngine: async <T,>(work: (loop: { baseUrl: string; token: string; port: number; voice: string }) => Promise<T>) => {
    engine.uses += 1
    // The real one waits for the engine before it hands it over.
    await Promise.resolve()
    if (engine.startError) throw engine.startError
    return work({ baseUrl: 'http://127.0.0.1:47720', token: 'launch-token', port: 47720, voice: 'alba' })
  },
}))

import { SAMPLE_DURING_SESSION, SAMPLE_FAILED, playVoiceSample } from '../voice-sample'

class FakeSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  started = false
  stopped = false
  connect() {}
  start() { this.started = true }
  stop() { this.stopped = true; this.onended?.() }
}
class FakeContext {
  static made: FakeContext[] = []
  static decodeFails = false
  closed = false
  sources: FakeSource[] = []
  destination = {}
  constructor() { FakeContext.made.push(this) }
  resume() { return Promise.resolve() }
  close() { this.closed = true; return Promise.resolve() }
  decodeAudioData(data: ArrayBuffer) {
    return FakeContext.decodeFails ? Promise.reject(new Error('EncodingError')) : Promise.resolve({ bytes: data.byteLength })
  }
  createBufferSource() {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
}

const fetchMock = vi.fn()
/** The moment the sample starts to play. */
const playing = () => vi.waitFor(() => {
  const source = FakeContext.made[0]?.sources[0]
  if (!source?.started) throw new Error('not playing yet')
  return source
})
const asked = () => vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

beforeEach(() => {
  engine.active = false
  engine.startError = null
  engine.uses = 0
  FakeContext.made = []
  FakeContext.decodeFails = false
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'audio/wav' } }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => vi.unstubAllGlobals())

describe('the sample of a voice', () => {
  it('asks the engine for the voice by name, with the launch token, and says nothing else', async () => {
    const sample = playVoiceSample('anna')
    const source = await playing()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:47720/sample')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer launch-token')
    expect(JSON.parse(String(init.body))).toEqual({ voice: 'anna' })
    source.onended?.()
    await sample.done
  })

  it('opens the audio output in the click, before anything is awaited', () => {
    playVoiceSample('alba').done.catch(() => {})
    expect(FakeContext.made).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('plays what came back, says when it plays, and closes the output at the end', async () => {
    const onPlaying = vi.fn()
    const sample = playVoiceSample('alba', onPlaying)
    const source = await playing()
    const context = FakeContext.made[0]
    expect(source.buffer).toEqual({ bytes: 64 })
    expect(onPlaying).toHaveBeenCalledTimes(1)
    expect(context.closed).toBe(false)
    context.sources[0].onended?.()
    await sample.done
    expect(context.closed).toBe(true)
  })

  it('stop ends a playing sample without an error', async () => {
    const sample = playVoiceSample('alba')
    const source = await playing()
    sample.stop()
    await expect(sample.done).resolves.toBeUndefined()
    expect(source.stopped).toBe(true)
    expect(FakeContext.made[0].closed).toBe(true)
  })

  it('stop before the engine has answered plays nothing', async () => {
    let answer: (response: Response) => void = () => {}
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { answer = resolve }))
    const sample = playVoiceSample('alba')
    await asked()
    sample.stop()
    answer(new Response(new Uint8Array(8), { status: 200 }))
    await expect(sample.done).resolves.toBeUndefined()
    expect(FakeContext.made[0].sources).toHaveLength(0)
  })

  it('not during a session: the engine is not even asked', async () => {
    engine.active = true
    await expect(playVoiceSample('alba').done).rejects.toThrow(SAMPLE_DURING_SESSION)
    expect(engine.uses).toBe(0)
    expect(FakeContext.made).toHaveLength(0)
  })

  it('the sentence of the engine reaches the user as it is', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'The voice anna is not installed.' }), { status: 422 }))
    await expect(playVoiceSample('anna').done).rejects.toThrow('The voice anna is not installed.')
    expect(FakeContext.made[0].closed).toBe(true)
  })

  it('the sentence of the app reaches the user as it is', async () => {
    engine.startError = 'The voice loop is not installed. Run the voice setup first.'
    await expect(playVoiceSample('alba').done).rejects.toThrow('The voice loop is not installed. Run the voice setup first.')
  })

  it('a dead engine, a refusal without words and broken audio get one plain sentence', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(playVoiceSample('alba').done).rejects.toThrow(SAMPLE_FAILED)
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))
    await expect(playVoiceSample('alba').done).rejects.toThrow(SAMPLE_FAILED)
    FakeContext.decodeFails = true
    await expect(playVoiceSample('alba').done).rejects.toThrow(SAMPLE_FAILED)
    expect(SAMPLE_FAILED).not.toMatch(/fetch/i)
  })
})
