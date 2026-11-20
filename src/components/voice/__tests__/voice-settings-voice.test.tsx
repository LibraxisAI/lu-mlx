/**
 * @vitest-environment jsdom
 *
 * The voice in the voice settings: pick one, hear it, and what the popup says
 * while a voice is fetched, while the sample loads and during a session.
 *
 * Run: npx vitest run src/components/voice/__tests__/voice-settings-voice.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { VoiceLoopRequirements } from '../../../api/voice-loop'
import { VOICE_IDLE } from '../../../lib/voice/session-state'

const session = vi.hoisted(() => ({ stopVoiceSession: vi.fn() }))
vi.mock('../../../api/voice-session', () => session)

interface Played { voice: string; onPlaying?: () => void; resolve: () => void; reject: (error: Error) => void; stop: ReturnType<typeof vi.fn> }
const sample = vi.hoisted(() => ({ played: [] as Played[] }))
vi.mock('../../../api/voice-sample', () => ({
  playVoiceSample: (voice: string, onPlaying?: () => void) => {
    let resolve = () => {}
    let reject: (error: Error) => void = () => {}
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const entry: Played = { voice, onPlaying, resolve, reject, stop: vi.fn(() => resolve()) }
    sample.played.push(entry)
    return { done, stop: entry.stop }
  },
}))

import { VoiceSettingsPopup } from '../VoiceSettingsPopup'
import type { VoiceSetup } from '../useVoiceSetup'
import { useVoiceSessionStore } from '../../../stores/voiceSessionStore'

const VOICES = [
  { name: 'alba', license: 'CC-BY-4.0', attribution: 'Voice "alba" from recordings by Alba MacKenna, licensed under CC BY 4.0.', bytes: 6_194_424, installed: true },
  { name: 'anna', license: 'CC-BY-4.0', attribution: 'Voice "anna" from the CSTR VCTK Corpus, licensed under CC BY 4.0.', bytes: 7_816_440, installed: false },
  { name: 'marius', license: 'CC0-1.0', attribution: 'Voice "marius" from the Unmute Voice Donation Project, released as CC0.', bytes: 6_194_424, installed: false },
]

function requirements(patch: Partial<VoiceLoopRequirements> = {}): VoiceLoopRequirements {
  return {
    supported: true, unsupportedReason: null, installed: true, installDir: '/data/voice',
    python: { version: '3.12.15', installed: true, downloadBytes: 25_013_243 },
    packages: { installed: true, downloadBytesEstimate: 335_000_000, diskBytesEstimate: 1_100_000_000, versions: {} },
    models: [
      { id: 'tts', name: 'Pocket TTS', role: 'tts', license: 'CC-BY-4.0', attribution: 'Pocket TTS by Kyutai, licensed under CC BY 4.0.', bytes: 219_088_535, installed: true },
      { id: 'tts-voice-alba', name: 'alba', role: 'tts-voice', license: 'CC-BY-4.0', attribution: VOICES[0].attribution, bytes: 6_194_424, installed: true },
    ],
    modelsBytes: 225_282_959, voice: 'alba', voices: VOICES,
    downloadBytes: 0, diskBytesNeeded: 0, diskBytesFree: 50_000_000_000, enoughSpace: true,
    ...patch,
  }
}

function setup(patch: Partial<VoiceSetup> = {}): VoiceSetup {
  return {
    mode: 'ready', requirements: requirements(), status: null, loadError: null, actionError: null,
    install: vi.fn(async () => {}), cancel: vi.fn(async () => {}), uninstall: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    chooseVoice: vi.fn(async () => {}), choosingVoice: null,
    ...patch,
  }
}

const open = (value: VoiceSetup, onClose = vi.fn()) => render(createElement(VoiceSettingsPopup, { open: true, onClose, setup: value }))
const line = (view: ReturnType<typeof open>) => view.getByTestId('voice-voice-line').textContent

beforeEach(() => {
  sample.played.length = 0
  useVoiceSessionStore.setState({ ...VOICE_IDLE })
})
afterEach(() => cleanup())

describe('the voice in the voice settings', () => {
  it('lists every voice by name and shows the chosen one', () => {
    const view = open(setup())
    const picker = view.getByLabelText('Voice') as HTMLSelectElement
    expect(picker.value).toBe('alba')
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Alba', 'Anna', 'Marius'])
    expect(line(view)).toBe('A voice that is not on this computer yet is downloaded when you pick it, up to 7.5 MB. A new voice speaks from the next session on.')
  })

  it('picking a voice hands its name to the setup', () => {
    const value = setup()
    const view = open(value)
    fireEvent.change(view.getByLabelText('Voice'), { target: { value: 'anna' } })
    expect(value.chooseVoice).toHaveBeenCalledWith('anna')
  })

  it('while a voice is fetched the list and Listen wait, and the line names the voice', () => {
    const view = open(setup({ choosingVoice: 'anna' }))
    expect((view.getByLabelText('Voice') as HTMLSelectElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: 'Listen' }) as HTMLButtonElement).disabled).toBe(true)
    expect(line(view)).toBe('Getting Anna ready.')
  })

  it('a voice that could not be fetched says why', () => {
    const view = open(setup({ actionError: 'The download of the voice anna was interrupted.' }))
    expect(view.getByRole('alert').textContent).toBe('The download of the voice anna was interrupted.')
  })

  it('Listen plays the chosen voice and becomes Stop', async () => {
    const view = open(setup({ requirements: requirements({ voice: 'marius' }) }))
    fireEvent.click(view.getByRole('button', { name: 'Listen' }))
    expect(sample.played.map((entry) => entry.voice)).toEqual(['marius'])
    expect(line(view)).toBe('Loading the voice. The first time this takes a moment.')
    act(() => sample.played[0].onPlaying?.())
    expect(view.getByRole('button', { name: 'Stop' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Stop' }))
    expect(sample.played[0].stop).toHaveBeenCalledTimes(1)
    expect(view.getByRole('button', { name: 'Listen' })).toBeTruthy()
  })

  it('a sample that ends by itself gives Listen back', async () => {
    const view = open(setup())
    fireEvent.click(view.getByRole('button', { name: 'Listen' }))
    await act(async () => { sample.played[0].resolve() })
    expect(view.getByRole('button', { name: 'Listen' })).toBeTruthy()
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('a sample that fails shows the sentence it failed with', async () => {
    const view = open(setup())
    fireEvent.click(view.getByRole('button', { name: 'Listen' }))
    await act(async () => { sample.played[0].reject(new Error('The voice anna is not installed.')) })
    expect(view.getByRole('alert').textContent).toBe('The voice anna is not installed.')
    expect(view.getByRole('button', { name: 'Listen' })).toBeTruthy()
  })

  it('picking another voice and closing the popup both end a running sample', () => {
    const onClose = vi.fn()
    const view = open(setup(), onClose)
    fireEvent.click(view.getByRole('button', { name: 'Listen' }))
    fireEvent.change(view.getByLabelText('Voice'), { target: { value: 'anna' } })
    expect(sample.played[0].stop).toHaveBeenCalledTimes(1)

    fireEvent.click(view.getByRole('button', { name: 'Listen' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(sample.played[1].stop).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('during a session the voice can be picked for the next one, and Listen waits', () => {
    useVoiceSessionStore.setState({ ...VOICE_IDLE, phase: 'live' })
    const view = open(setup())
    expect((view.getByLabelText('Voice') as HTMLSelectElement).disabled).toBe(false)
    expect((view.getByRole('button', { name: 'Listen' }) as HTMLButtonElement).disabled).toBe(true)
    expect(line(view)).toBe('A new voice speaks from the next session on. Stop the session to listen to a voice.')
  })

  it('before the engine is installed there is nothing to listen to', () => {
    const view = open(setup({ mode: 'needed', requirements: requirements({ installed: false }) }))
    expect((view.getByRole('button', { name: 'Listen' }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByLabelText('Voice') as HTMLSelectElement).disabled).toBe(false)
  })

  it('the credit of the chosen voice stands in the popup', () => {
    const view = open(setup())
    expect(view.container.ownerDocument.body.textContent).toContain('Voice "alba" from recordings by Alba MacKenna')
  })

  it('has an X and no word that names the assistant project', () => {
    const view = open(setup())
    expect(view.getByRole('button', { name: /close/i })).toBeTruthy()
    expect(view.container.ownerDocument.body.textContent).not.toMatch(/astra/i)
    expect(view.container.ownerDocument.body.textContent).not.toMatch(/[\u2013\u2014]/)
  })
})
