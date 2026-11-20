/**
 * @vitest-environment jsdom
 *
 * Gegenprobe on the real build, 30.09.2026: an eight minute Code run read
 * "12s" after the user left the tab and came back. The clock started when the
 * component mounted, not when the run did. It now counts from the run's
 * booked start (generationStore runs[id].bookedAt).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { WorkingAnchor } from '../WorkingAnchor'
import { useGenerationStore } from '../../../stores/generationStore'

const T0 = new Date('2026-09-30T18:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  useGenerationStore.setState({ runs: {}, generating: {}, aborters: {} })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const clock = () => screen.getByTestId('working-anchor').textContent

describe('the Working clock', () => {
  it('counts from the run start, also in a component mounted later', () => {
    useGenerationStore.getState().bookRun('c1', 'cloud', Symbol('run'))
    vi.setSystemTime(T0 + 8 * 60_000)
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c1' }))
    act(() => { vi.advanceTimersByTime(300) })
    expect(clock()).toContain('8m 00s')
  })

  it('keeps counting across an unmount and a new mount', () => {
    useGenerationStore.getState().bookRun('c1', 'cloud', Symbol('run'))
    const first = render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c1' }))
    act(() => { vi.advanceTimersByTime(90_000) })
    first.unmount()
    act(() => { vi.advanceTimersByTime(10_000) })
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c1' }))
    act(() => { vi.advanceTimersByTime(300) })
    expect(clock()).toContain('1m 40s')
  })

  it('without a booked run it still counts from its own start', () => {
    render(createElement(WorkingAnchor, { isRunning: true }))
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(clock()).toContain('5s')
  })
})
