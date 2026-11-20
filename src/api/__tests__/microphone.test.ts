// The one microphone choice: what is listed, what is opened, and what happens
// when the chosen device is gone or comes back under another id.
//
// Run: npx vitest run src/api/__tests__/microphone.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseMicrophone, listMicrophones, matchMicrophone, onMicrophoneChosen, openMicrophone, unlockMicrophoneNames } from '../microphone'
import { createAudioRecorder } from '../voice'
import { useVoiceStore } from '../../stores/voiceStore'

interface Device { kind: string; deviceId: string; label: string }
const input = (deviceId: string, label: string): Device => ({ kind: 'audioinput', deviceId, label })

let present: Device[] = []
let refuse: string | null = null
const opened: { deviceId: string | null; stopped: boolean }[] = []

function named(name: string): Error {
  return Object.assign(new Error(name), { name })
}

const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
  if (refuse) throw named(refuse)
  const audio = constraints.audio
  const wanted = typeof audio === 'object' ? (audio.deviceId as { exact?: string } | undefined)?.exact ?? null : null
  if (wanted && !present.some((d) => d.deviceId === wanted)) throw named('OverconstrainedError')
  if (!present.length) throw named('NotFoundError')
  const entry = { deviceId: wanted, stopped: false }
  opened.push(entry)
  const track = { stop: () => { entry.stopped = true } }
  return { entry, getTracks: () => [track] } as unknown as MediaStream
})

const asked = () => getUserMedia.mock.calls.map(([c]) => c.audio)

beforeEach(() => {
  present = [input('default', 'Default - Desk microphone'), input('desk-1', 'Desk microphone'), input('head-1', 'Headset')]
  refuse = null
  opened.length = 0
  getUserMedia.mockClear()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => present } })
  useVoiceStore.getState().resetVoiceDefaults()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the list of microphones', () => {
  it('holds the named devices and leaves out the aliases of the system default', async () => {
    expect(await listMicrophones()).toEqual([
      { deviceId: 'desk-1', label: 'Desk microphone' },
      { deviceId: 'head-1', label: 'Headset' },
    ])
  })

  it('is empty while the webview does not name its devices', async () => {
    // What a webview lists before the microphone was allowed.
    present = [input('', ''), input('a1b2c3', ''), { kind: 'audiooutput', deviceId: 'out', label: 'Speakers' }]
    expect(await listMicrophones()).toEqual([])
  })

  it('has names once the microphone was asked for, and lets go of it again', async () => {
    expect(await unlockMicrophoneNames()).toHaveLength(2)
    expect(opened).toEqual([{ deviceId: null, stopped: true }])
  })

  it('passes a refusal on to whoever asked', async () => {
    refuse = 'NotAllowedError'
    await expect(unlockMicrophoneNames()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})

describe('a remembered choice against the devices that are there', () => {
  const mics = [{ deviceId: 'desk-1', label: 'Desk microphone' }]
  it.each([
    [{ deviceId: '', label: '' }, { state: 'default' }],
    [{ deviceId: 'desk-1', label: 'Desk microphone' }, { state: 'present', deviceId: 'desk-1' }],
    [{ deviceId: 'desk-0', label: 'Desk microphone' }, { state: 'renamed', deviceId: 'desk-1' }],
    [{ deviceId: 'head-1', label: 'Headset' }, { state: 'absent' }],
    [{ deviceId: 'head-1', label: '' }, { state: 'absent' }],
  ])('%o is %o', (chosen, match) => {
    expect(matchMicrophone(chosen, mics)).toEqual(match)
  })
})

describe('opening the microphone', () => {
  it('takes the system default while nothing is chosen', async () => {
    await openMicrophone()
    expect(asked()).toEqual([true])
  })

  it('takes exactly the chosen device and keeps the constraints of the caller', async () => {
    chooseMicrophone('head-1', 'Headset')
    await openMicrophone({ echoCancellation: true })
    expect(asked()).toEqual([{ echoCancellation: true, deviceId: { exact: 'head-1' } }])
  })

  it('falls back to the system default when the chosen device is unplugged, and keeps the choice', async () => {
    chooseMicrophone('head-1', 'Headset')
    present = present.filter((d) => d.deviceId !== 'head-1')
    await openMicrophone()
    expect(asked()).toEqual([{ deviceId: { exact: 'head-1' } }, true])
    expect(opened).toEqual([{ deviceId: null, stopped: false }])
    expect(useVoiceStore.getState()).toMatchObject({ micId: 'head-1', micLabel: 'Headset' })
  })

  it('finds the chosen device again by its name when the webview gave it a new id', async () => {
    chooseMicrophone('head-1', 'Headset')
    const chosen = vi.fn()
    const off = onMicrophoneChosen(chosen)
    present = [input('desk-1', 'Desk microphone'), input('head-2', 'Headset')]
    const stream = await openMicrophone() as unknown as { entry: { deviceId: string } }
    off()
    expect(stream.entry.deviceId).toBe('head-2')
    // The default one was only opened to get at the names, and is closed again.
    expect(opened).toEqual([{ deviceId: null, stopped: true }, { deviceId: 'head-2', stopped: false }])
    expect(useVoiceStore.getState()).toMatchObject({ micId: 'head-2', micLabel: 'Headset' })
    // A new id is not a new choice: a running session is not told to switch.
    expect(chosen).not.toHaveBeenCalled()
  })

  it('asks once and throws when the microphone is refused', async () => {
    chooseMicrophone('head-1', 'Headset')
    refuse = 'NotAllowedError'
    await expect(openMicrophone()).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('throws what the system default says when no microphone is there at all', async () => {
    chooseMicrophone('head-1', 'Headset')
    present = []
    await expect(openMicrophone()).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('choosing a microphone', () => {
  it('is remembered with its name and told to whoever listens', () => {
    const chosen = vi.fn()
    const off = onMicrophoneChosen(chosen)
    chooseMicrophone('desk-1', 'Desk microphone')
    expect(useVoiceStore.getState()).toMatchObject({ micId: 'desk-1', micLabel: 'Desk microphone' })
    chooseMicrophone('', 'ignored')
    expect(useVoiceStore.getState()).toMatchObject({ micId: '', micLabel: '' })
    expect(chosen.mock.calls).toEqual([['desk-1'], ['']])
    off()
    chooseMicrophone('head-1', 'Headset')
    expect(chosen).toHaveBeenCalledTimes(2)
  })

  it('survives a restart together with its name', () => {
    chooseMicrophone('desk-1', 'Desk microphone')
    const kept = useVoiceStore.persist.getOptions().partialize!(useVoiceStore.getState()) as Record<string, unknown>
    expect(kept).toMatchObject({ micId: 'desk-1', micLabel: 'Desk microphone' })
  })
})

describe('dictation in chat', () => {
  class FakeNode { connect() {} disconnect() {} }
  class FakeContext {
    sampleRate = 48000
    state = 'running'
    destination = new FakeNode()
    createMediaStreamSource() { return new FakeNode() }
    createScriptProcessor() { return Object.assign(new FakeNode(), { onaudioprocess: null }) }
    createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }) }
    close() { return Promise.resolve() }
  }
  beforeEach(() => { vi.stubGlobal('window', { AudioContext: FakeContext }) })

  it('records from the chosen microphone', async () => {
    chooseMicrophone('head-1', 'Headset')
    const recorder = createAudioRecorder()
    await recorder.start()
    expect(asked()).toEqual([{ deviceId: { exact: 'head-1' } }])
    await recorder.stop()
  })

  it('records from the system default instead of failing when that microphone is unplugged', async () => {
    chooseMicrophone('head-1', 'Headset')
    present = present.filter((d) => d.deviceId !== 'head-1')
    const recorder = createAudioRecorder()
    await recorder.start()
    expect(recorder.isRecording()).toBe(true)
    expect(opened.at(-1)).toEqual({ deviceId: null, stopped: false })
    await recorder.stop()
  })
})
