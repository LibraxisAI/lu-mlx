// @vitest-environment jsdom
/**
 * The bar "LU is controlling this computer": up while computer control is
 * busy and a few seconds longer, not for the minutes its session lives on,
 * and placed inside the main panel so it never covers the navigation.
 *
 * Run: npx vitest run src/components/computer/__tests__/control-bar.test.tsx
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

const busy = { now: false }
vi.mock('../../../api/computer-use', () => ({
  computerControlBusy: () => busy.now,
  noteComputerStopped: vi.fn(),
  resumeComputerControl: vi.fn(),
  setComputerAutonomy: vi.fn(),
  dismissComputerStop: vi.fn(),
  stopComputerControl: vi.fn(),
  computerRunOrigin: () => ({ voice: false, conversationId: null }),
}))
vi.mock('../../../api/backend', () => ({ isTauri: () => false }))

import { BAR_LINGER_MS, ComputerControlHost, barPlacement } from '../ComputerControlHost'
import { useComputerStore } from '../../../stores/computerStore'

const SESSION = { id: 's1', autonomous: false, allowed: [], stopped: null, frameId: null } as never

function mainPanel(left: number, top: number, width: number) {
  const main = document.createElement('main')
  main.getBoundingClientRect = () => ({ left, top, width, height: 400, right: left + width, bottom: top + 400, x: left, y: top, toJSON: () => ({}) })
  document.body.appendChild(main)
  return main
}

beforeEach(() => {
  vi.useFakeTimers()
  busy.now = false
  useComputerStore.setState({ shrinks: null, session: null, stopped: null, prompt: null, notice: null, task: null, working: false, currentApp: null, autonomous: false, stopShortcut: 'Ctrl+Alt+Esc' })
})

afterEach(() => {
  cleanup()
  document.querySelectorAll('main').forEach((node) => node.remove())
  vi.useRealTimers()
})

describe('how long the bar stays', () => {
  it('is up while computer control is busy and gone a few seconds after, although the session lives on', () => {
    const view = render(createElement(ComputerControlHost))
    busy.now = true
    act(() => { useComputerStore.getState().setSession(SESSION, 'Ctrl+Alt+Esc') })
    act(() => { vi.advanceTimersByTime(10) })
    expect(view.getByTestId('computer-control-bar').textContent).toContain('LU is controlling this computer')

    busy.now = false
    act(() => { vi.advanceTimersByTime(BAR_LINGER_MS - 600) })
    expect(view.queryByTestId('computer-control-bar')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1200) })
    expect(view.queryByTestId('computer-control-bar')).toBeNull()
    // The session and what was allowed in it are untouched.
    expect(useComputerStore.getState().session).not.toBeNull()
  })

  it('comes back with the next piece of work', () => {
    const view = render(createElement(ComputerControlHost))
    act(() => { useComputerStore.getState().setSession(SESSION, 'Ctrl+Alt+Esc') })
    act(() => { vi.advanceTimersByTime(BAR_LINGER_MS + 1000) })
    expect(view.queryByTestId('computer-control-bar')).toBeNull()
    busy.now = true
    act(() => { useComputerStore.getState().setWorking(true) })
    expect(view.queryByTestId('computer-control-bar')).not.toBeNull()
  })

  it('work that pauses for less than the linger keeps the bar up without a blink', () => {
    const view = render(createElement(ComputerControlHost))
    busy.now = true
    act(() => { useComputerStore.getState().setSession(SESSION, 'Ctrl+Alt+Esc') })
    act(() => { vi.advanceTimersByTime(10) })
    for (let round = 0; round < 3; round += 1) {
      busy.now = false
      act(() => { vi.advanceTimersByTime(BAR_LINGER_MS - 1000) })
      expect(view.queryByTestId('computer-control-bar')).not.toBeNull()
      busy.now = true
      act(() => { vi.advanceTimersByTime(1000) })
    }
    expect(view.queryByTestId('computer-control-bar')).not.toBeNull()
  })

  it('a stop is not told by the bar any more: the note above the input field says it', () => {
    const view = render(createElement(ComputerControlHost))
    busy.now = true
    act(() => { useComputerStore.getState().setSession(SESSION, 'Ctrl+Alt+Esc') })
    act(() => { vi.advanceTimersByTime(10) })
    expect(view.queryByTestId('computer-control-bar')).not.toBeNull()
    act(() => { useComputerStore.getState().setStopped({ reason: 'user', message: 'The user stopped computer control.', runToken: null }) })
    act(() => { vi.advanceTimersByTime(10) })
    expect(view.queryByTestId('computer-control-bar')).toBeNull()
  })

  it('where the window becomes the small panel there is no bar at all, not for a moment', () => {
    const view = render(createElement(ComputerControlHost))
    // Rust answered once: this system shrinks the window.
    act(() => { useComputerStore.getState().setShrinks(true) })
    busy.now = true
    act(() => { useComputerStore.getState().setSession(SESSION, 'Ctrl+Alt+Esc') })
    act(() => { vi.advanceTimersByTime(10) })
    expect(view.queryByTestId('computer-control-bar')).toBeNull()
    busy.now = false
    act(() => { vi.advanceTimersByTime(BAR_LINGER_MS - 500) })
    expect(view.queryByTestId('computer-control-bar')).toBeNull()
  })
})

describe('where the bar lies', () => {
  it('inside the main panel of a 900 pixel window, clear of the sidebar and the header', () => {
    // 900 by 600: sidebar to 297, main panel from 305 to 892, header above 92.
    const place = barPlacement({ left: 305, top: 92, width: 587 })
    const style = place.style!
    const width = Number(style.maxWidth)
    const left = Number(style.left) - width / 2
    expect(left).toBeGreaterThanOrEqual(305)
    expect(left + width).toBeLessThanOrEqual(892)
    expect(Number(style.top)).toBeGreaterThan(92)
    expect(place.className).not.toContain('left-1/2')
  })

  it('no wider than before in a large window', () => {
    expect(barPlacement({ left: 300, top: 92, width: 1600 }).style!.maxWidth).toBe(704)
  })

  it('in the middle when there is no panel to measure, and never at the top edge: no question stands there any more', () => {
    expect(barPlacement(null).className).toContain('top-[5.5rem]')
    expect(barPlacement(null).className).not.toContain('top-2')
  })

  it('the rendered bar takes its place from the panel that is there', () => {
    mainPanel(305, 92, 587)
    const view = render(createElement(ComputerControlHost))
    busy.now = true
    act(() => { useComputerStore.getState().setSession(SESSION, 'Ctrl+Alt+Esc') })
    act(() => { vi.advanceTimersByTime(10) })
    act(() => { vi.advanceTimersByTime(10) })
    const bar = view.getByTestId('computer-control-bar')
    expect(bar.style.left).toBe('598.5px')
    expect(bar.style.top).toBe('136px')
    expect(bar.style.maxWidth).toBe('571px')
  })
})
