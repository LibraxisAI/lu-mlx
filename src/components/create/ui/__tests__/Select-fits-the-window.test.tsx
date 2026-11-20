// @vitest-environment jsdom
/**
 * GitHub #149: the Create model list ended up under the bottom edge of the
 * window. The arithmetic has its own tests (lib/__tests__/
 * das-popover-bleibt-in-der-flaeche.test.ts); this one checks that the
 * component really hands its measurements to it and wears the result, and
 * that picking, Escape and resizing still work.
 *
 * jsdom has no layout, so the three things the hook reads are given here:
 * the trigger's box, the window size and the height of the list's content.
 *
 * Run: npx vitest run src/components/create/ui/__tests__/Select-fits-the-window.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../Select'

const OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, label: `Model ${i}` }))

/** Where the trigger sits, in window pixels. Set per test. */
let trigger = { top: 0, bottom: 0, left: 0, right: 0 }

function setWindow(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

const restore: Array<() => void> = []
function stub<K extends keyof HTMLElement>(key: K, get: (this: HTMLElement) => HTMLElement[K]) {
  const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  Object.defineProperty(HTMLElement.prototype, key, { get, configurable: true })
  restore.push(() => {
    if (before) Object.defineProperty(HTMLElement.prototype, key, before)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  })
}

beforeEach(() => {
  setWindow(900, 400)
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const t = this.classList.contains('trigger-under-test') ? trigger : { top: 0, bottom: 0, left: 0, right: 0 }
    return { ...t, x: t.left, y: t.top, width: t.right - t.left, height: t.bottom - t.top, toJSON: () => t }
  })
  restore.push(() => rect.mockRestore())
  // Twelve rows of 32 px in a list the menu has squeezed to 44 px; the menu
  // itself (search field, padding, squeezed list) stands at 100 px.
  stub('scrollHeight', function () { return this.getAttribute('role') === 'listbox' ? 384 : 100 })
  stub('clientHeight', function () { return this.getAttribute('role') === 'listbox' ? 44 : 100 })
  stub('offsetHeight', function () { return 100 })
  stub('offsetWidth', function () { return 220 })
})

afterEach(() => {
  cleanup()
  while (restore.length) restore.pop()?.()
})

function open(onChange = vi.fn()) {
  render(<Select className="trigger-under-test" ariaLabel="Model" searchable align="right" options={OPTIONS} value="m0" onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  return { menu: screen.getByRole('listbox').parentElement as HTMLElement, onChange }
}

describe('the Create model list takes the room there is', () => {
  it('room below: opens downward at the trigger', () => {
    trigger = { top: 20, bottom: 50, left: 500, right: 720 }
    const { menu } = open()
    expect(menu.style.position).toBe('fixed')
    expect(menu.style.top).toBe('54px')
    expect(menu.style.bottom).toBe('')
    // 400 - 50 - 4 gap - 8 margin. The content (100 + 280 - 44 = 336) fits.
    expect(menu.style.maxHeight).toBe('338px')
  })

  it('no room below, room above: opens upward (the reported case)', () => {
    trigger = { top: 340, bottom: 370, left: 500, right: 720 }
    const { menu } = open()
    expect(menu.style.top).toBe('')
    expect(menu.style.bottom).toBe('64px')
    expect(menu.style.maxHeight).toBe('328px')
    // Right-aligned to its trigger, and no wider than the window allows.
    expect(menu.style.right).toBe('180px')
    expect(menu.style.minWidth).toBe('220px')
    expect(menu.style.maxWidth).toBe('712px')
  })

  it('neither side is enough: the larger one, capped, and the list scrolls', () => {
    trigger = { top: 150, bottom: 180, left: 500, right: 720 }
    const { menu } = open()
    expect(menu.style.top).toBe('184px')
    expect(menu.style.maxHeight).toBe('208px')
    expect(screen.getByRole('listbox').className).toContain('overflow-y-auto')
    expect(screen.getByRole('listbox').className).toContain('min-h-0')
  })

  it('follows the window when it gets shorter', () => {
    trigger = { top: 20, bottom: 50, left: 500, right: 720 }
    const { menu } = open()
    expect(menu.style.maxHeight).toBe('338px')
    act(() => {
      setWindow(900, 200)
      window.dispatchEvent(new Event('resize'))
    })
    expect(menu.style.maxHeight).toBe('138px')
  })
})

describe('and is still the same control', () => {
  beforeEach(() => { trigger = { top: 340, bottom: 370, left: 500, right: 720 } })

  it('a click picks the model and closes the list', () => {
    const { onChange } = open()
    fireEvent.click(screen.getByRole('option', { name: 'Model 11' }))
    expect(onChange).toHaveBeenCalledWith('m11')
    expect(screen.getByRole('button', { name: 'Model' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape closes it without picking', () => {
    const { onChange } = open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Model' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('the search field has the keyboard and narrows the list', () => {
    open()
    const search = screen.getByPlaceholderText('Search...')
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'Model 7' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })
})
