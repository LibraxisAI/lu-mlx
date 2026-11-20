/**
 * Bug hunt 01.10.2026 (H2). The streamed text was written from a
 * requestAnimationFrame callback that was never taken back. The error line
 * (the stall message included) and the empty-answer explanation are written
 * directly, and a frame still pending then put the partial text back on top.
 * A hidden tab runs no frames until it is shown, so there the late frame was
 * certain to win.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { frameFlush } from '../frame-flush'

let queue: Map<number, FrameRequestCallback>
let next = 1
const runFrames = () => { const q = [...queue.values()]; queue.clear(); q.forEach((f) => f(0)) }

beforeEach(() => {
  queue = new Map()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = next++; queue.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id) })
})
afterEach(() => vi.unstubAllGlobals())

describe('the streamed-text frame', () => {
  it('a pending frame does not land on the error written after it (the hidden tab case)', () => {
    let bubble = ''
    const frames = frameFlush()
    const partial = 'Writing the pa'
    frames.schedule(() => { bubble = partial })
    // The stream fails while the tab is hidden: no frame has run yet.
    frames.close()
    bubble = 'LU Cloud ended this step: no data from the model for 90 seconds.'
    // The tab is shown again, the frame queue drains.
    runFrames()
    expect(bubble).toBe('LU Cloud ended this step: no data from the model for 90 seconds.')
  })

  it('writes at most once per frame while streaming, with the latest text', () => {
    const writes: string[] = []
    let text = ''
    const frames = frameFlush()
    for (const piece of ['a', 'b', 'c']) {
      text += piece
      frames.schedule(() => writes.push(text))
    }
    runFrames()
    frames.schedule(() => writes.push(text + '!'))
    runFrames()
    expect(writes).toEqual(['abc', 'abc!'])
  })

  it('refuses frames after the stream ended', () => {
    const frames = frameFlush()
    frames.close()
    let ran = false
    frames.schedule(() => { ran = true })
    runFrames()
    expect(ran).toBe(false)
  })
})

describe('every place that streams into a bubble closes the frame before its own write', () => {
  const src = (f: string) => readFileSync(resolve(__dirname, '../../hooks', f), 'utf8')

  it('the chat, both paths', () => {
    const chat = src('useChat.ts')
    expect(chat).not.toMatch(/requestAnimationFrame\(/)
    expect(chat.match(/frames\.schedule\(/g)).toHaveLength(2)
    expect(chat.match(/if \(chunk\.done\) \{\s+frames\.close\(\)/g)).toHaveLength(2)
    expect(chat.match(/\} catch \(err\) \{\s+frames\.close\(\)/g)).toHaveLength(2)
    // After the loop, before the empty-answer lines.
    expect(chat).toMatch(/frames\.close\(\)\s+\/\/ Thought-only completion/)
    expect(chat).toMatch(/frames\.close\(\)\s+if \(!abort\.signal\.aborted && !contentAcc\.trim\(\)\)/)
  })

  it('the Agent tab', () => {
    const agent = src('useAgentChat.ts')
    // (The workflow progress frame stays a plain requestAnimationFrame: it
    // reads the run's current status when it fires, so it cannot write a stale
    // one.)
    expect(agent).toMatch(/function scheduleUIUpdate\(\) \{\s+frames\.schedule\(/)
    expect(agent).toMatch(/\/\/ Final store update\s+frames\.close\(\)/)
    expect(agent).toMatch(/\} catch \(err\) \{\s+frames\.close\(\)\s+if \(\(err as Error\)\.name !== 'AbortError'\)/)
  })
})
