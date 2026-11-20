import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toolProgressActivity, useRunActivityStore, waitBeforeRetry } from '../runActivityStore'

const activity = (id: string) => useRunActivityStore.getState().activity[id]

describe('the wait before a model call is tried again', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useRunActivityStore.setState({ activity: {} })
  })
  afterEach(() => { vi.useRealTimers() })

  it('says Retrying for the length of the wait and takes it back before the next attempt', async () => {
    const wait = waitBeforeRetry('c1', 4000)
    expect(activity('c1')).toEqual({ label: 'Retrying', kind: 'retrying' })
    await vi.advanceTimersByTimeAsync(3999)
    expect(activity('c1')).toEqual({ label: 'Retrying', kind: 'retrying' })
    await vi.advanceTimersByTimeAsync(1)
    await wait
    expect(activity('c1')).toBeUndefined()
  })

  it('does not take back a line that something else wrote in the meantime', async () => {
    const wait = waitBeforeRetry('c1', 1000)
    const writing = toolProgressActivity({ name: 'file_write', argsChars: 10 } as never)
    useRunActivityStore.getState().setActivity('c1', writing)
    await vi.advanceTimersByTimeAsync(1000)
    await wait
    expect(activity('c1')).toEqual(writing)
  })

  it('still waits without a conversation to tell', async () => {
    let done = false
    void waitBeforeRetry(null, 500).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('ends at once when the run is stopped', async () => {
    const stop = new AbortController()
    let done = false
    void waitBeforeRetry('c1', 60_000, stop.signal).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(done).toBe(false)
    stop.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(activity('c1')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start a wait for a run that is already stopped', async () => {
    const stop = new AbortController()
    stop.abort()
    await waitBeforeRetry('c1', 60_000, stop.signal)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('both retry waits of the agent loop go through it', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/hooks/useAgentChat.ts'), 'utf8')
    expect(source.match(/await waitBeforeRetry\(convId, wait, abort\.signal\)/g)).toHaveLength(2)
    expect(source).not.toMatch(/announceWait\(thinkErr, wait\)\s*\n\s*await new Promise/)
  })
})
