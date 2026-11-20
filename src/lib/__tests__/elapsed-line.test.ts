/**
 * The one counter every waiting line of a local run uses: "<what is
 * happening> 12s", repainted every second, so a step that takes minutes never
 * looks hung. The box, 03.10.2026: "Improving your prompt…" stood still for
 * 175 s on an edit, the only waiting line without it.
 *
 * Run: npx vitest run src/lib/__tests__/elapsed-line.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { elapsedLine } from '../elapsed-line'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('elapsedLine', () => {
  it('paints at once and then every second, counting from its start', () => {
    const lines: string[] = []
    const line = elapsedLine((text) => lines.push(text), 'Improving your prompt…')
    expect(lines).toEqual(['Improving your prompt… 0s'])
    vi.advanceTimersByTime(3000)
    expect(lines.at(-1)).toBe('Improving your prompt… 3s')
    expect(lines).toHaveLength(4)
    line.stop()
  })

  it('a new label repaints at once and keeps the count running', () => {
    const lines: string[] = []
    const line = elapsedLine((text) => lines.push(text), 'Queued...')
    vi.advanceTimersByTime(5000)
    line.setLabel('Loading model...')
    expect(lines.at(-1)).toBe('Loading model... 5s')
    vi.advanceTimersByTime(1000)
    expect(lines.at(-1)).toBe('Loading model... 6s')
    line.stop()
  })

  it('stops painting when it is stopped', () => {
    const lines: string[] = []
    const line = elapsedLine((text) => lines.push(text), 'Queued...')
    line.stop()
    vi.advanceTimersByTime(5000)
    expect(lines).toHaveLength(1)
  })
})
