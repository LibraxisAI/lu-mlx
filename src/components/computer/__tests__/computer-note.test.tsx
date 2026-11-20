// @vitest-environment jsdom
/**
 * What computer control says while LU is its ordinary window stands as one
 * small line in the middle, directly above the input field: the short note
 * after the first yes in a chat, which takes itself down, and a stop with
 * its reason, which stays until the user writes on, sends or closes it.
 *
 * Run: npx vitest run src/components/computer/__tests__/computer-note.test.tsx
 */
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

const dismissed = vi.hoisted(() => ({ times: 0 }))
vi.mock('../../../api/computer-use', () => ({
  dismissComputerStop: () => {
    dismissed.times += 1
    const state = useComputerStore.getState()
    if (state.stopped) state.setStopped({ ...state.stopped, dismissed: true })
  },
}))
vi.mock('../../../api/backend', () => ({ isMacOS: () => false, isTauri: () => false }))

import { ComputerNote } from '../ComputerNote'
import { useComputerStore } from '../../../stores/computerStore'
import { NOTE_GAP_PX, START_NOTE_MS, holdForStartNote, noteLift } from '../../../lib/computer/start-note'

const note = () => document.querySelector<HTMLElement>('[data-testid="computer-note"]')
const STOP = { reason: 'takeover' as const, message: 'The user took over the mouse or keyboard, so computer control stopped.', runToken: 'r1' }
const read = (file: string) => readFileSync(resolve(__dirname, '../../..', file), 'utf8')

beforeEach(() => {
  vi.useFakeTimers()
  dismissed.times = 0
  useComputerStore.setState({ startNote: null, stopped: null, surface: 'window', shrinks: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the note after the first yes in a chat', () => {
  it('says that LU controls the computer and how to stop, and takes itself down after about two and a half seconds', () => {
    render(createElement(ComputerNote))
    expect(note()).toBeNull()
    act(() => { useComputerStore.getState().setStartNote(Date.now()) })
    expect(note()!.dataset.kind).toBe('start')
    expect(note()!.textContent).toContain('LU is controlling this computer')
    expect(note()!.textContent).toContain('Stop: Ctrl+Alt+Esc')
    expect(note()!.querySelector('button')).toBeNull()
    act(() => { vi.advanceTimersByTime(START_NOTE_MS - 100) })
    expect(note()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(200) })
    expect(note()).toBeNull()
    expect(useComputerStore.getState().startNote).toBeNull()
  })

  it('stands for about two and a half seconds, and the window waits exactly that long before it gets out of the way', async () => {
    expect(START_NOTE_MS).toBe(2500)
    let over = false
    void holdForStartNote().then(() => { over = true })
    await vi.advanceTimersByTimeAsync(START_NOTE_MS - 1)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(over).toBe(true)
    // One number: the wait cannot fall behind the note again.
    expect(read('lib/computer/start-note.ts')).not.toContain('START_NOTE_HOLD_MS')
    // The wait sits before the session begins, so nothing of the task runs in it.
    const gate = read('api/computer-chat.ts')
    expect(gate.indexOf('await holdForStartNote(signal)')).toBeGreaterThan(gate.indexOf('setStartNote(Date.now())'))
    const use = read('api/computer-use.ts')
    expect(use).toContain("computerChatGate(run, signal).then((refused) => (refused !== null ? { text: refused, end: 'no_chat' } : queuedComputerStep(args, run, signal)))")
  })

  it('a stop ends the wait at once', async () => {
    const stop = new AbortController()
    let over = false
    void holdForStartNote(stop.signal).then(() => { over = true })
    stop.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(over).toBe(true)
  })

  it('is not shown while LU is the small panel, and not where the bar with Stop says the same', () => {
    useComputerStore.setState({ startNote: Date.now(), surface: 'panel' })
    render(createElement(ComputerNote))
    expect(note()).toBeNull()
    act(() => { useComputerStore.setState({ surface: 'window', shrinks: false }) })
    expect(note()).toBeNull()
  })
})

describe('a stop with its reason', () => {
  it('stays, however long, until it is closed with the small X', () => {
    render(createElement(ComputerNote))
    act(() => { useComputerStore.getState().setStopped({ ...STOP, at: Date.now() }) })
    expect(note()!.dataset.kind).toBe('stopped')
    expect(note()!.textContent).toContain('Computer control stopped. The user took over the mouse or keyboard')
    act(() => { vi.advanceTimersByTime(600_000) })
    expect(note()).not.toBeNull()
    fireEvent.click(note()!.querySelector('button[aria-label="Dismiss"]')!)
    expect(note()).toBeNull()
    // Closing the note does not lift the stop.
    expect(useComputerStore.getState().stopped).toMatchObject({ dismissed: true })
  })

  it('is told on a system that keeps the window too', () => {
    useComputerStore.setState({ shrinks: false, stopped: { ...STOP, at: Date.now() } })
    render(createElement(ComputerNote))
    expect(note()!.dataset.kind).toBe('stopped')
  })

  it('writing on and sending a message take it down: the chat input says so to the store', () => {
    const input = read('components/chat/ChatInput.tsx')
    const typing = input.slice(input.indexOf('const updateInput = '), input.indexOf('const updateInput = ') + 220)
    expect(typing).toContain('dismissComputerStop()')
    const sending = input.slice(input.indexOf('const handleSend = '), input.indexOf('const updateInput = '))
    expect(sending).toContain('dismissComputerStop()')
  })
})

describe('one note at a time', () => {
  it('the newer one wins: a stop after the start replaces it, a start after a stop replaces that', () => {
    render(createElement(ComputerNote))
    act(() => { useComputerStore.getState().setStartNote(Date.now()) })
    act(() => { useComputerStore.getState().setStopped({ ...STOP, at: Date.now() + 5 }) })
    expect(document.querySelectorAll('[data-testid="computer-note"]')).toHaveLength(1)
    expect(note()!.dataset.kind).toBe('stopped')
    act(() => { useComputerStore.getState().setStartNote(Date.now() + 1000) })
    expect(document.querySelectorAll('[data-testid="computer-note"]')).toHaveLength(1)
    expect(note()!.dataset.kind).toBe('start')
  })
})

describe('the shape and the place', () => {
  it('is announced politely and takes no room: nothing moves when it comes and goes', () => {
    useComputerStore.setState({ startNote: Date.now() })
    render(createElement(ComputerNote))
    expect(note()!.getAttribute('aria-live')).toBe('polite')
    expect(note()!.getAttribute('role')).toBe('status')
    expect(document.querySelector('[data-testid="computer-note-place"]')!.className).toContain('h-0')
    const css = read('index.css')
    const rule = css.slice(css.indexOf('.lu-computer-note {'), css.indexOf('.light .lu-computer-note {'))
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('left: 50%')
    expect(rule).toContain('bottom: calc(100% + 6px)')
    expect(rule).toContain('font-size: 11px')
    // Less motion asked for: it is simply there and gone.
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.lu-computer-note,\s*\.lu-computer-note--passing \{\s*animation: none;/)
  })

  it('stands directly above the input field of the chat and on the voice surface, and the old place is gone', () => {
    const input = read('components/chat/ChatInput.tsx')
    expect(input.indexOf('<ComputerNote />')).toBeGreaterThan(input.indexOf('<ComputerQuestionSlot'))
    expect(input.indexOf('<ComputerNote />')).toBeLessThan(input.indexOf('<textarea'))
    expect(read('components/voice/VoiceSessionPanel.tsx')).toContain('<ComputerNote />')
    const host = read('components/computer/ComputerControlHost.tsx')
    expect(host).not.toContain('Computer control stopped.')
    expect(host).not.toContain('Allow again')
  })

  it('the questions of computer control are not part of it', () => {
    const source = read('components/computer/ComputerNote.tsx')
    expect(source).not.toMatch(/ComputerQuestion|ComputerChatPermission|prompt\b/)
  })
})

describe('the note gives way, the strip of the session does not', () => {
  // The input is 760 wide from 400; the note hangs in its middle, 27 high, 6 above it.
  const note = { left: 611, right: 949, top: 671, bottom: 698 }
  const chips = { left: 408, right: 570, top: 668, bottom: 690 }
  const meter = { left: 868, right: 1010, top: 668, bottom: 690 }

  it('stays directly above the input field where nothing stands in its way', () => {
    expect(noteLift(note, [])).toBe(0)
    expect(noteLift(note, [chips, { ...meter, left: 960, right: 1100 }])).toBe(0)
    // A strip higher up is not in its way either.
    expect(noteLift(note, [{ ...meter, top: 600, bottom: 622 }])).toBe(0)
  })

  it('goes above the strip where it would lie on the context meter', () => {
    const lift = noteLift(note, [chips, meter])
    expect(lift).toBe(note.bottom - meter.top + NOTE_GAP_PX)
    // Lifted, it ends above the strip with the same room it keeps to the input.
    expect(note.bottom - lift).toBe(meter.top - NOTE_GAP_PX)
  })

  it('goes above the chips on the left as well, in a narrow window', () => {
    const narrow = { left: 20, right: 358, top: 671, bottom: 698 }
    const lift = noteLift(narrow, [{ left: 12, right: 150, top: 660, bottom: 690 }, { left: 250, right: 370, top: 668, bottom: 690 }])
    expect(narrow.bottom - lift).toBe(660 - NOTE_GAP_PX)
  })

  it('an empty spacer counts for nothing', () => {
    expect(noteLift(note, [{ left: 570, right: 570, top: 668, bottom: 690 }])).toBe(0)
  })

  it('the chat marks its strip, the note reads the mark, and the note is the one that moves', () => {
    expect(read('components/chat/ChatView.tsx')).toContain('data-testid="chat-session-strip" data-computer-note-yields=""')
    const source = read('components/computer/ComputerNote.tsx')
    expect(source).toContain("document.querySelectorAll('[data-computer-note-yields]')")
    expect(source).toContain('bottom: `calc(100% + ${NOTE_GAP_PX + lift}px)`')
    const css = read('index.css')
    const rule = css.slice(css.indexOf('.lu-computer-note {'), css.indexOf('.light .lu-computer-note {'))
    expect(rule).toContain('max-width: min(94%, 30rem)')
  })

  it('moves up in the page when a part of the strip is in its way', () => {
    const strip = document.createElement('div')
    strip.setAttribute('data-computer-note-yields', '')
    const part = document.createElement('button'); part.textContent = '5.2K/32K'
    const spacer = document.createElement('div')
    strip.append(spacer, part); document.body.append(strip)
    const rect = (box: { left: number; right: number; top: number; bottom: number }) => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box }) as DOMRect
    part.getBoundingClientRect = () => rect(meter)
    spacer.getBoundingClientRect = () => rect({ left: 570, right: 868, top: 668, bottom: 690 })
    const real = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () { return this.dataset.testid === 'computer-note' ? rect(note) : real.call(this) }
    try {
      useComputerStore.setState({ startNote: Date.now(), surface: 'window', shrinks: true, stopped: null })
      render(createElement(ComputerNote))
      const shown = document.querySelector<HTMLElement>('[data-testid="computer-note"]')!
      expect(shown.dataset.lift).toBe(String(note.bottom - meter.top + NOTE_GAP_PX))
      expect(shown.style.bottom).toBe(`calc(100% + ${note.bottom - meter.top + 2 * NOTE_GAP_PX}px)`)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real
      strip.remove()
    }
  })
})
