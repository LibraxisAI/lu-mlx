/**
 * @vitest-environment jsdom
 *
 * GH #139: typing in the composer lagged ~1 s per key in larger chats, and
 * the lag grew with the visible transcript. Each key collapsed the live field
 * to `height: auto` to read its scrollHeight and then set it back, which laid
 * out (and on WebKitGTK repainted) the whole transcript twice per key.
 *
 * jsdom has no layout, so the copy's scrollHeight is stood in by a line count
 * (20 px a line plus 8 px padding). What is pinned here is the contract that
 * fixes the lag: the live field is never collapsed, its height is written only
 * when it really changes, and the measuring copy is invisible to the page.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { fitTextarea } from '../fit-textarea'

const LINE = 20
const PAD = 8
let restore: PropertyDescriptor | undefined

beforeAll(() => {
  restore = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      const lines = Math.max(this.rows || 1, this.value.split('\n').length)
      return lines * LINE + PAD
    },
  })
})

afterAll(() => {
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight
  if (restore) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', restore)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function field(value = ''): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  el.rows = 1
  el.style.width = '300px'
  el.value = value
  document.body.appendChild(el)
  return el
}

function heightWrites(el: HTMLTextAreaElement): string[] {
  const writes: string[] = []
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el.style), 'height')!
  Object.defineProperty(el.style, 'height', {
    configurable: true,
    get() { return desc.get!.call(this) },
    set(v: string) { writes.push(v); desc.set!.call(this, v) },
  })
  return writes
}

describe('fitTextarea', () => {
  it('sizes the field to its text', () => {
    const el = field('one line')
    fitTextarea(el, 200)
    expect(el.style.height).toBe(`${LINE + PAD}px`)
  })

  it('typing within a line never writes the field height (the lag)', () => {
    const el = field('')
    fitTextarea(el, 200)
    const writes = heightWrites(el)
    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      el.value = text
      fitTextarea(el, 200)
    }
    expect(writes).toEqual([])
  })

  it('a new line writes the new height once, and never collapses to auto', () => {
    const el = field('first')
    fitTextarea(el, 200)
    const writes = heightWrites(el)
    el.value = 'first\nsecond'
    fitTextarea(el, 200)
    expect(writes).toEqual([`${2 * LINE + PAD}px`])
    expect(writes).not.toContain('auto')
  })

  it('stops at the cap', () => {
    const el = field(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
    fitTextarea(el, 200)
    expect(el.style.height).toBe('200px')
  })

  it('leaves a field that is not laid out alone', () => {
    const el = field('x')
    el.style.width = ''
    fitTextarea(el, 200)
    expect(el.style.height).toBe('')
  })

  it('the measuring copy is invisible to the page', () => {
    const el = field('x')
    fitTextarea(el, 200)
    // Tests and page code that look for "the" textarea still find only one.
    expect(document.querySelectorAll('textarea')).toHaveLength(1)
    const host = document.querySelector('[data-lu-textarea-mirror]')
    expect(host?.getAttribute('aria-hidden')).toBe('true')
    // Closed: tools that look into open shadow roots (Playwright, CDP) must
    // not find the copy either.
    expect(host).toBeTruthy()
    expect(host?.shadowRoot).toBeNull()
  })

  it('comes back after the page was cleared', () => {
    field('x')
    fitTextarea(document.querySelector('textarea')!, 200)
    document.body.innerHTML = ''
    const el = field('a\nb')
    fitTextarea(el, 200)
    expect(el.style.height).toBe(`${2 * LINE + PAD}px`)
  })
})

describe('no field collapses itself to measure any more', () => {
  const root = join(__dirname, '..', '..')
  for (const file of [
    'components/chat/ChatInput.tsx',
    'components/chat/MessageBubble.tsx',
    'components/create/ui/PromptField.tsx',
  ]) {
    it(file, () => {
      const src = readFileSync(join(root, file), 'utf8')
      expect(src).not.toMatch(/style\.height\s*=\s*'auto'/)
      expect(src).toContain('fitTextarea(')
    })
  }
})
