/**
 * @vitest-environment jsdom
 *
 * Realtime pass 01.10.2026 (R1): the run anchor says which call the model is
 * writing instead of "Working", with the size that has arrived. An explicit
 * label from the surface (an approval wait) still wins, and a run without
 * activity still reads "Working".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { WorkingAnchor } from '../WorkingAnchor'
import { useRunActivityStore, toolProgressActivity } from '../../../stores/runActivityStore'

beforeEach(() => {
  useRunActivityStore.setState({ activity: {} })
})
afterEach(() => cleanup())

const anchor = () => screen.getByTestId('working-anchor').textContent ?? ''

describe('the run anchor while a call is written', () => {
  it('reads Working until the run reports a call, then names it with its size', () => {
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c1' }))
    expect(anchor()).toContain('Working')

    act(() => useRunActivityStore.getState().setActivity('c1', toolProgressActivity({ name: 'file_write', argsChars: 300 })))
    expect(anchor()).toContain('Preparing to write')
    expect(anchor()).not.toContain('kB')

    act(() => useRunActivityStore.getState().setActivity('c1', toolProgressActivity({ name: 'file_write', argsChars: 2300 })))
    expect(anchor()).toContain('Preparing to write')
    expect(anchor()).toContain('2 kB')

    act(() => useRunActivityStore.getState().setActivity('c1', null))
    expect(anchor()).toContain('Working')
  })

  it('an approval wait wins, and another conversation does not leak in', () => {
    useRunActivityStore.getState().setActivity('c1', toolProgressActivity({ name: 'shell_execute', argsChars: 10 }))
    useRunActivityStore.getState().setActivity('c2', toolProgressActivity({ name: 'file_write', argsChars: 10 }))
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c1', awaitingApproval: true }))
    expect(anchor()).toContain('Waiting for your approval')
    expect(anchor()).not.toContain('Preparing')
    cleanup()
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c3' }))
    expect(anchor()).toContain('Working')
  })

  it('the store ignores a write that changes nothing, so a stream of deltas within one kB does not re-render', () => {
    let writes = 0
    const off = useRunActivityStore.subscribe(() => { writes++ })
    for (let chars = 1024; chars < 2048; chars += 37) {
      useRunActivityStore.getState().setActivity('c1', toolProgressActivity({ name: 'file_write', argsChars: chars }))
    }
    off()
    expect(writes).toBe(1)
  })
})
