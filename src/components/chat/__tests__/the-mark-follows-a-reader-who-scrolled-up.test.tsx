// @vitest-environment jsdom
/**
 * The owner, roadmap: "LU loading mark above the prompt window when one scrolls
 * up while the model works."
 *
 * The run status line sits at the end of the transcript. Scrolled up, nothing
 * on screen said that the run was still going. Now the mark alone floats above
 * the composer for exactly as long as the line is out of view and the run
 * lives.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-mark-follows-a-reader-who-scrolled-up.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkingAnchor } from '../WorkingAnchor'
import { beaconShows, jumpToLatest, scrollParent, watchAnchor } from '../working-beacon'

/** A stand-in for the browser's observer: the test decides what is in view. */
class FakeObserver {
  static all: FakeObserver[] = []
  targets: Element[] = []
  gone = false
  private cb: (entries: Array<{ isIntersecting: boolean }>) => void
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.cb = cb
    FakeObserver.all.push(this)
  }
  observe(el: Element) { this.targets.push(el) }
  disconnect() { this.gone = true }
  report(...inView: boolean[]) {
    this.cb(inView.map((isIntersecting) => ({ isIntersecting })))
  }
}
const live = () => FakeObserver.all.filter((o) => !o.gone)

beforeEach(() => {
  FakeObserver.all = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('when the mark shows', () => {
  it('only while a run lives and its status line is out of view', () => {
    expect(beaconShows({ running: true, observed: true, anchorInView: false })).toBe(true)
    expect(beaconShows({ running: true, observed: true, anchorInView: true })).toBe(false)
    expect(beaconShows({ running: false, observed: true, anchorInView: false })).toBe(false)
  })

  it('never before the browser has said where the line is', () => {
    expect(beaconShows({ running: true, observed: false, anchorInView: false })).toBe(false)
  })

  it('the last of several queued reports wins', () => {
    const seen: boolean[] = []
    const el = document.createElement('div')
    watchAnchor(el, (v) => seen.push(v), FakeObserver as unknown as typeof IntersectionObserver)
    live()[0].report(false, true, false)
    expect(seen).toEqual([false])
  })

  it('a browser without the observer shows nothing and does not throw', () => {
    const seen: boolean[] = []
    const stop = watchAnchor(document.createElement('div'), (v) => seen.push(v), undefined)
    stop()
    expect(seen).toEqual([])
  })
})

describe('in the transcript', () => {
  const mount = (isRunning = true) =>
    render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <WorkingAnchor isRunning={isRunning} conversationId="c1" />
      </div>,
    )

  it('watches the status line itself', () => {
    mount()
    expect(live()).toHaveLength(1)
    expect(live()[0].targets).toEqual([screen.getByTestId('working-anchor')])
  })

  it('stays away while the line is in view', () => {
    mount()
    expect(screen.queryByTestId('working-beacon')).toBeNull()
    act(() => live()[0].report(true))
    expect(screen.queryByTestId('working-beacon')).toBeNull()
  })

  it('comes when the line leaves, goes when it is back, and comes again', () => {
    mount()
    act(() => live()[0].report(false))
    expect(screen.getByTestId('working-beacon')).toBeTruthy()
    act(() => live()[0].report(true))
    expect(screen.queryByTestId('working-beacon')).toBeNull()
    act(() => live()[0].report(false))
    expect(screen.getByTestId('working-beacon')).toBeTruthy()
  })

  it('is the mark alone: no word, no clock', () => {
    mount()
    act(() => live()[0].report(false))
    const mark = screen.getByTestId('working-beacon')
    expect(mark.textContent).toBe('')
    expect(mark.querySelector('[data-testid="status-glyph"]')).toBeTruthy()
    expect(mark.getAttribute('aria-label')).toBe('Jump to the latest message')
  })

  it('shows the same state as the line', () => {
    const view = render(
      <div style={{ overflowY: 'auto' }}>
        <WorkingAnchor isRunning conversationId="c1" awaitingApproval />
      </div>,
    )
    act(() => live()[0].report(false))
    const line = view.getByTestId('working-anchor')
    expect(view.getByTestId('working-beacon').getAttribute('data-status')).toBe(line.getAttribute('data-status'))
    expect(line.getAttribute('data-status')).toBe('approval')
  })

  it('is gone with the run, and the observer with it', () => {
    const view = mount()
    const first = live()[0]
    act(() => first.report(false))
    view.rerender(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <WorkingAnchor isRunning={false} conversationId="c1" />
      </div>,
    )
    expect(screen.queryByTestId('working-beacon')).toBeNull()
    expect(screen.queryByTestId('working-beacon-holder')).toBeNull()
    expect(first.gone).toBe(true)
  })

  it('a click goes to the end of the transcript it stands in', () => {
    mount()
    const scroller = screen.getByTestId('scroller')
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true })
    act(() => live()[0].report(false))
    expect(scrollParent(screen.getByTestId('working-beacon-holder'))).toBe(scroller)
    fireEvent.click(screen.getByTestId('working-beacon'))
    expect(scroller.scrollTop).toBe(4000)
  })

  it('jumping from nowhere does nothing', () => {
    expect(() => jumpToLatest(null)).not.toThrow()
  })
})

describe('it takes no room and stays out of the prompt window', () => {
  const strip = (src: string) =>
    src.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  const read = (name: string) => strip(readFileSync(resolve(__dirname, '..', name), 'utf-8'))

  it('the holder is a sticky line of zero height that lets clicks through', () => {
    expect(read('WorkingBeacon.tsx')).toMatch(/className="pointer-events-none sticky bottom-0 z-10 h-0"/)
  })

  it('the mark hangs above that line instead of standing in the flow', () => {
    expect(read('WorkingBeacon.tsx')).toMatch(/pointer-events-auto absolute bottom-1 left-1\/2/)
  })

  it('it lives in the transcript, next to the status line, not in the composer', () => {
    expect(read('WorkingAnchor.tsx')).toMatch(/<WorkingBeacon anchor=\{line\} kind=\{status\.kind\} \/>/)
    expect(read('ChatInput.tsx')).not.toMatch(/WorkingBeacon|working-beacon/)
  })
})
