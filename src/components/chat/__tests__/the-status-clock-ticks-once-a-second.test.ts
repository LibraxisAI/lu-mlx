/**
 * @vitest-environment jsdom
 *
 * The clock next to the status word is the only thing in the status line that
 * React renders while a run goes on. It updates when the shown second changes
 * and at no other time, and it leaves nothing behind when the line goes away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { WorkingAnchor } from '../WorkingAnchor'
import { useGenerationStore } from '../../../stores/generationStore'

const T0 = new Date('2026-10-06T09:00:00Z').getTime()

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
const anchor = (isRunning = true) => createElement(WorkingAnchor, { isRunning, conversationId: 'c1', message: { content: '' } })

describe('the clock of a run', () => {
  it('shows nothing in the first second, then counts whole seconds', () => {
    render(anchor())
    expect(line()).toBe('Starting')
    act(() => { vi.advanceTimersByTime(999) })
    expect(line()).toBe('Starting')
    act(() => { vi.advanceTimersByTime(1) })
    expect(line()).toBe('Starting1s')
    act(() => { vi.advanceTimersByTime(59_000) })
    expect(line()).toBe('Starting1m 00s')
  })

  it('holds one timer, and that timer fires once per second', () => {
    render(anchor())
    expect(vi.getTimerCount()).toBe(1)
    const spy = vi.spyOn(globalThis, 'setTimeout')
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(spy.mock.calls.filter(([, ms]) => ms === 1000)).toHaveLength(10)
    expect(vi.getTimerCount()).toBe(1)
    spy.mockRestore()
  })

  it('a line mounted in the middle of a second ticks when that second ends', () => {
    act(() => { vi.advanceTimersByTime(2_400) })
    render(anchor())
    expect(line()).toBe('Starting2s')
    act(() => { vi.advanceTimersByTime(599) })
    expect(line()).toBe('Starting2s')
    act(() => { vi.advanceTimersByTime(1) })
    expect(line()).toBe('Starting3s')
  })

  it('leaves no timer behind when the line is taken away', () => {
    const view = render(anchor())
    act(() => { vi.advanceTimersByTime(3_000) })
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer behind when the run ends', () => {
    const view = render(anchor())
    act(() => { vi.advanceTimersByTime(3_000) })
    view.rerender(anchor(false))
    expect(screen.queryByTestId('working-anchor')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a change of state keeps the clock running', () => {
    const view = render(anchor())
    act(() => { vi.advanceTimersByTime(4_000) })
    view.rerender(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c1', message: { content: 'Hi' } }))
    expect(line()).toBe('Responding4s')
    expect(vi.getTimerCount()).toBe(1)
  })
})
