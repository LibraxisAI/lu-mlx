/**
 * The status anchor is a status, not a line of text (D-S11).
 *
 * The finding was "a single word with a shimmer, in a still image not
 * distinguishable from body text". The shimmer only says something while it
 * runs and while someone looks: in a screenshot, under
 * `prefers-reduced-motion`, or out of the corner of an eye, a grey word in
 * text size stood where an answer would otherwise begin.
 *
 * Until 3.0.5 a pill with a dot set the line apart. Now the LU mark does: a
 * drawn sign in front of the word, which is a sign with or without motion.
 * This test pins what works WITHOUT movement: the mark, the type step, the
 * number recipe, and the announcement for screen readers.
 *
 * Run: npx vitest run src/components/chat/__tests__/der-statusanker-ist-kein-fliesstext.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const strip = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8')

const ANCHOR_SRC = read('WorkingAnchor.tsx')
const ANCHOR = strip(ANCHOR_SRC)
const CHIP = strip(read('..', 'status', 'StatusChip.tsx'))
const GLYPH = strip(read('..', 'status', 'StatusGlyph.tsx'))

describe('in a still image it is a status, not a paragraph', () => {
  it('the line opens with the mark', () => {
    expect(CHIP).toMatch(/<StatusGlyph kind=\{kind\} \/>/)
    expect(CHIP.indexOf('<StatusGlyph')).toBeLessThan(CHIP.indexOf('{word}'))
  })

  it('the line is as wide as its content, not as wide as the column', () => {
    expect(CHIP).toMatch(/inline-flex w-fit items-center/)
  })

  it('there is no pill around it any more, and nothing took its place', () => {
    expect(CHIP).not.toMatch(/rounded-full/)
    expect(CHIP).not.toMatch(/bg-gray-50|bg-white\//)
    expect(ANCHOR).not.toMatch(/lu-band-dot/)
  })

  it('the mark stands still as a drawn sign when nothing may move', () => {
    expect(GLYPH).toMatch(/useReducedMotion\(\)/)
    expect(GLYPH).toMatch(/standingPose\(kind, id\)/)
  })

  it('the word takes its size from the type ladder and keeps the house shimmer', () => {
    expect(CHIP).toMatch(/lu-tool-shimmer t-control/)
    expect(CHIP).not.toMatch(/text-\[/)
  })

  it('the clock uses the house recipe for numbers', () => {
    expect(CHIP).toMatch(/lu-hud-num/)
    expect(CHIP).not.toMatch(/font-mono tabular-nums/)
  })
})

describe('and it says something when nobody is looking', () => {
  it('the anchor is a status region', () => {
    expect(ANCHOR).toMatch(/role="status"/)
    expect(ANCHOR).toMatch(/aria-live="polite"/)
  })

  it('the clock is left out of the announcement and ticks once per second', () => {
    const clock = CHIP.slice(CHIP.indexOf('{seconds != null'), CHIP.indexOf('formatElapsed(seconds)'))
    expect(clock).toMatch(/aria-hidden="true"/)
    expect(ANCHOR_SRC).not.toMatch(/setInterval/)
    expect(ANCHOR_SRC).toMatch(/setTimeout\(tick, 1000 - \(ms % 1000\)\)/)
  })

  it('so is the mark: it is decoration, the word carries the meaning', () => {
    expect(GLYPH).toMatch(/aria-hidden="true"/)
  })
})

describe('the colours of the mark are calculated, not guessed', () => {
  /** WCAG 2.1 relative luminance. */
  const lum = (r: number, g: number, b: number) => {
    const f = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const WHITE = lum(255, 255, 255) // chat surface, light
  const DARK = lum(30, 30, 30) // chat surface, dark (#1e1e1e)

  it('the letters carry the accent edge on light, because the accent itself is too weak there', () => {
    expect(ratio(lum(160, 148, 248), WHITE)).toBeLessThan(3) // --color-lu-accent #a094f8
    expect(ratio(lum(139, 124, 240), WHITE)).toBeGreaterThanOrEqual(3) // --color-lu-accent-edge #8b7cf0
    expect(GLYPH).toContain('text-lu-accent-edge dark:text-lu-accent')
  })

  it('on dark the accent itself is enough by a wide margin', () => {
    expect(ratio(lum(160, 148, 248), DARK)).toBeGreaterThan(6)
  })

  it('the frame is the quiet grey of the clock and reads on both surfaces', () => {
    // text-gray-500 is remapped by the theme layer: gray-400 on dark, gray-700 on light.
    expect(GLYPH).toMatch(/FRAME_CLASS = 'text-gray-500'/)
    expect(ratio(lum(156, 163, 175), DARK)).toBeGreaterThan(3)
    expect(ratio(lum(55, 65, 81), WHITE)).toBeGreaterThan(3)
  })
})
