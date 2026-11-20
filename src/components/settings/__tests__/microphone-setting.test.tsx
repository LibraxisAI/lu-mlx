/**
 * @vitest-environment jsdom
 *
 * The microphone field of the settings: what it lists before and after the
 * microphone was allowed, and what it shows for a device that is unplugged.
 *
 * Run: npx vitest run src/components/settings/__tests__/microphone-setting.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MicrophoneSetting } from '../MicrophoneSetting'
import { useVoiceStore } from '../../../stores/voiceStore'

interface Device { kind: string; deviceId: string; label: string }
const NAMED: Device[] = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - Desk microphone' },
  { kind: 'audioinput', deviceId: 'desk-1', label: 'Desk microphone' },
  { kind: 'audioinput', deviceId: 'head-1', label: 'Headset' },
]
const UNNAMED: Device[] = [{ kind: 'audioinput', deviceId: '', label: '' }]

let present: Device[] = []
let allowed: Device[] | Error = NAMED
const listeners = new Set<() => void>()
const stop = vi.fn()

function stubDevices(mediaDevices: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
}

const options = () => Array.from(screen.getByTestId('settings-microphone').querySelectorAll('option')).map((o) => o.textContent)
const select = () => screen.getByTestId('settings-microphone') as HTMLSelectElement
const shown = (coversVoice = true) => render(createElement(MicrophoneSetting, { coversVoice }))

beforeEach(() => {
  present = NAMED
  allowed = NAMED
  listeners.clear()
  stop.mockClear()
  stubDevices({
    enumerateDevices: async () => present,
    getUserMedia: async () => {
      if (allowed instanceof Error) throw allowed
      present = allowed
      return { getTracks: () => [{ stop }] }
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })
  useVoiceStore.getState().resetVoiceDefaults()
})
afterEach(() => { cleanup() })

describe('the microphone field in the settings', () => {
  it('lists the system default and the named microphones', async () => {
    shown()
    await waitFor(() => expect(options()).toEqual(['System default', 'Desk microphone', 'Headset']))
    expect(select().value).toBe('')
    expect(screen.queryByTestId('settings-microphone-allow')).toBeNull()
    expect(screen.getByTestId('settings-microphone-hint').textContent).toBe('Used for dictation in chat and for Voice.')
  })

  it('names dictation only where Voice is not offered', async () => {
    shown(false)
    await waitFor(() => expect(options()).toHaveLength(3))
    expect(screen.getByTestId('settings-microphone-hint').textContent).toBe('Used for dictation in chat.')
  })

  it('shows no nameless entry before the microphone was allowed, and the names after', async () => {
    present = UNNAMED
    shown()
    await waitFor(() => expect(screen.getByTestId('settings-microphone-allow')).toBeTruthy())
    expect(options()).toEqual(['System default'])
    fireEvent.click(screen.getByTestId('settings-microphone-allow'))
    await waitFor(() => expect(options()).toEqual(['System default', 'Desk microphone', 'Headset']))
    // The microphone was only asked for, not kept open.
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('settings-microphone-allow')).toBeNull()
  })

  it('does not offer the button before the webview has answered once', async () => {
    present = UNNAMED
    shown()
    // The first listing is still on its way: no verdict about names yet.
    expect(screen.queryByTestId('settings-microphone-allow')).toBeNull()
    expect(screen.getByTestId('settings-microphone-hint').textContent).toBe('Used for dictation in chat and for Voice.')
    await screen.findByTestId('settings-microphone-allow')
  })

  it('says in plain words that the microphone is blocked', async () => {
    present = UNNAMED
    allowed = Object.assign(new Error('Permission denied by system'), { name: 'NotAllowedError' })
    shown()
    fireEvent.click(await screen.findByTestId('settings-microphone-allow'))
    expect((await screen.findByRole('alert')).textContent).toBe('The microphone is blocked for this app.')
    expect(options()).toEqual(['System default'])
  })

  it('remembers the picked microphone with its name', async () => {
    shown()
    await waitFor(() => expect(options()).toHaveLength(3))
    fireEvent.change(select(), { target: { value: 'head-1' } })
    expect(useVoiceStore.getState()).toMatchObject({ micId: 'head-1', micLabel: 'Headset' })
    expect(select().value).toBe('head-1')
  })

  it('keeps an unplugged microphone chosen and says what is used meanwhile', async () => {
    useVoiceStore.getState().updateVoiceSettings({ micId: 'head-1', micLabel: 'Headset' })
    present = NAMED.filter((d) => d.deviceId !== 'head-1')
    shown()
    await waitFor(() => expect(options()).toEqual(['System default', 'Desk microphone', 'Headset (not connected)']))
    expect(select().value).toBe('head-1')
    expect(screen.getByTestId('settings-microphone-hint').textContent).toContain('Headset is not connected, so the system default is used until it is back.')
    expect(useVoiceStore.getState().micId).toBe('head-1')

    // Plugged in again: the list follows without a reload.
    present = NAMED
    await act(async () => { listeners.forEach((listener) => listener()) })
    await waitFor(() => expect(options()).toEqual(['System default', 'Desk microphone', 'Headset']))
    expect(select().value).toBe('head-1')
  })

  it('shows the remembered name without a verdict while the devices have no names yet', async () => {
    useVoiceStore.getState().updateVoiceSettings({ micId: 'head-1', micLabel: 'Headset' })
    present = UNNAMED
    shown()
    await waitFor(() => expect(options()).toEqual(['System default', 'Headset']))
    expect(select().value).toBe('head-1')
  })

  it('follows a microphone that came back under a new id', async () => {
    useVoiceStore.getState().updateVoiceSettings({ micId: 'head-0', micLabel: 'Headset' })
    shown()
    await waitFor(() => expect(useVoiceStore.getState().micId).toBe('head-1'))
    expect(select().value).toBe('head-1')
    expect(options()).toEqual(['System default', 'Desk microphone', 'Headset'])
  })

  it('says so when the window cannot record at all', async () => {
    stubDevices(undefined)
    shown()
    expect(screen.getByTestId('settings-microphone-hint').textContent).toBe('This window cannot access a microphone.')
    expect(select().disabled).toBe(true)
    expect(screen.queryByTestId('settings-microphone-allow')).toBeNull()
  })
})
