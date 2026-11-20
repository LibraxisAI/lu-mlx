/**
 * @vitest-environment jsdom
 *
 * Gegenprobe on the real build, 01.10.2026: the approval card had just come up
 * and the status line already read "Waiting for your approval 6s", the run's
 * time, not the wait. An explicit label now counts from when it appeared, and
 * the run's own clock comes back when the wait ends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { WorkingAnchor } from '../WorkingAnchor'
import { useGenerationStore } from '../../../stores/generationStore'

const T0 = new Date('2026-10-01T09:00:00Z').getTime()
const WAIT = 'Waiting for your approval'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  useGenerationStore.setState({ runs: {}, generating: {}, aborters: {} })
  useGenerationStore.getState().bookRun('c1', 'cloud', Symbol('run'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const line = () => screen.getByTestId('working-anchor').textContent ?? ''
const props = (label?: string) => ({ isRunning: true, conversationId: 'c1', awaitingApproval: !!label })

describe('the clock next to an approval wait', () => {
  it('starts at the card, then the run clock comes back', () => {
    const view = render(createElement(WorkingAnchor, props()))
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(line()).toContain('6s')

    view.rerender(createElement(WorkingAnchor, props(WAIT)))
    act(() => { vi.advanceTimersByTime(300) })
    expect(line()).toContain(WAIT)
    expect(line()).not.toContain('6s')
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(line()).toContain('4s')

    view.rerender(createElement(WorkingAnchor, props()))
    act(() => { vi.advanceTimersByTime(300) })
    expect(line()).toContain('10s')
  })

  it('a tab switch during the wait keeps the wait time', () => {
    const first = render(createElement(WorkingAnchor, props(WAIT)))
    act(() => { vi.advanceTimersByTime(20_000) })
    first.unmount()
    act(() => { vi.advanceTimersByTime(5_000) })
    render(createElement(WorkingAnchor, props(WAIT)))
    act(() => { vi.advanceTimersByTime(300) })
    expect(line()).toContain('25s')
  })

  it('the next approval of a later run counts from its own start', () => {
    const view = render(createElement(WorkingAnchor, props(WAIT)))
    act(() => { vi.advanceTimersByTime(30_000) })
    // The run ends while the card is open (Stop), then a new run asks again.
    view.rerender(createElement(WorkingAnchor, { ...props(WAIT), isRunning: false }))
    act(() => { vi.advanceTimersByTime(60_000) })
    view.rerender(createElement(WorkingAnchor, props(WAIT)))
    act(() => { vi.advanceTimersByTime(2_300) })
    expect(line()).toContain('2s')
    expect(line()).not.toContain('1m')
  })
})
