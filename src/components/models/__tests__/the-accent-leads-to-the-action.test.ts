/**
 * The Model Manager used to be one grey: every tile, every button and every
 * count in the same two tones, so nothing said where to press. Since the
 * redesign of October 2026 the accent stands on the action of a card and
 * nowhere else, as `.lu-tonal`, and the cards share one surface, `.lu-tile`.
 *
 * A tinted button is only an improvement while its word can be read. The
 * numbers quoted next to the recipes in index.css are computed here, from the
 * values that are really in the stylesheet, on the pane the page really lies
 * on. Change a token or a percentage and this file says what it costs.
 *
 * Run: npx vitest run src/components/models/__tests__/the-accent-leads-to-the-action.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from '../../__tests__/wcag-contrast'

const SRC = resolve(__dirname, '..', '..', '..')
const CSS = readFileSync(resolve(SRC, 'index.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const SHELL = readFileSync(resolve(SRC, 'components', 'layout', 'AppShell.tsx'), 'utf8')
const TILES = readFileSync(resolve(__dirname, '..', 'ModelTiles.tsx'), 'utf8')

const token = (name: string): string => {
  const v = CSS.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
  if (!v) throw new Error(`no hex token ${name}`)
  return v
}
/** The declarations of one rule, found by its exact selector. */
const rule = (selector: string): string => {
  const at = CSS.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule ${selector}`)
  return CSS.slice(at, CSS.indexOf('}', at))
}
const percent = (decls: string, prop: string): number => {
  const v = decls.match(new RegExp(`${prop}:[^;]*?(\\d+)%`))?.[1]
  if (!v) throw new Error(`no percentage in ${prop}`)
  return Number(v) / 100
}
const whiteAlpha = (decls: string): number =>
  Number(decls.match(/background-color:\s*rgba\(255, 255, 255, ([\d.]+)\)/)![1])
const rgb = (decls: string): string => {
  const m = decls.match(/background-color:\s*rgb\((\d+) (\d+) (\d+)\)/)!
  return `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
}

const ACCENT = token('--color-lu-accent')
const ACCENT_HOVER = token('--color-lu-accent-hover')
const INK = token('--color-lu-accent-ink')

// The pane the page lies on, read from the shell and not assumed.
const PANE_DARK = SHELL.match(/<main className="[^"]*dark:bg-\[(#[0-9a-f]{6})\]/)![1]
const PANE_LIGHT = '#ffffff'

const TILE_DARK = over('#ffffff', PANE_DARK, whiteAlpha(rule('.lu-tile')))
const TILE_DARK_HOVER = over('#ffffff', PANE_DARK, whiteAlpha(rule('.lu-tile:hover')))
const TILE_LIGHT = rgb(rule('.light .lu-tile'))
const TILE_LIGHT_HOVER = rgb(rule('.light .lu-tile:hover'))

const FILL = percent(rule('.lu-tonal'), 'background-color')
const FILL_HOVER = percent(rule('.lu-tonal:hover:not(:disabled)'), 'background-color')

const AA = 4.5

describe('the word on the tinted button can be read', () => {
  it('the shell still paints the pane this arithmetic stands on', () => {
    expect(SHELL).toMatch(/<main className="[^"]*bg-white dark:bg-\[#/)
  })

  it('dark: the accent on its own fill, on a tile at rest and under the pointer', () => {
    expect(contrast(ACCENT, over(ACCENT, TILE_DARK, FILL))).toBeGreaterThanOrEqual(AA)
    expect(contrast(ACCENT, over(ACCENT, TILE_DARK_HOVER, FILL))).toBeGreaterThanOrEqual(AA)
  })

  it('dark: the hovered button, stronger fill and lifted accent', () => {
    expect(contrast(ACCENT_HOVER, over(ACCENT, TILE_DARK_HOVER, FILL_HOVER))).toBeGreaterThanOrEqual(AA)
  })

  it('light: the ink on the fill, on a tile at rest and under the pointer', () => {
    expect(rule('.light .lu-tonal')).toContain('color: var(--color-lu-accent-ink)')
    expect(contrast(INK, over(ACCENT, TILE_LIGHT, FILL))).toBeGreaterThanOrEqual(AA)
    expect(contrast(INK, over(ACCENT, TILE_LIGHT_HOVER, FILL))).toBeGreaterThanOrEqual(AA)
  })

  it('light: the hovered button keeps the ink', () => {
    expect(rule('.light .lu-tonal:hover:not(:disabled)')).toContain('color: var(--color-lu-accent-ink)')
    expect(contrast(INK, over(ACCENT, TILE_LIGHT_HOVER, FILL_HOVER))).toBeGreaterThanOrEqual(AA)
  })

  it('COUNTERCHECK: the plain accent as a word in the light is what the ink is for', () => {
    // Without the ink token the light theme would put #a094f8 on white.
    expect(contrast(ACCENT, PANE_LIGHT)).toBeLessThan(3)
    expect(contrast(INK, PANE_LIGHT)).toBeGreaterThanOrEqual(AA)
    expect(contrast(INK, TILE_LIGHT)).toBeGreaterThanOrEqual(AA)
  })
})

describe('one recipe each, and the tiles use them', () => {
  it('the action of a tile is the tonal recipe, the rest is the neutral one', () => {
    expect(TILES).toMatch(/export const TILE_ACTION = 'lu-tonal'/)
    expect(TILES).toMatch(/export const TILE_ACTION_QUIET = 'lu-control lu-control--outline'/)
  })

  it('the tonal button has the height and the corner of the neutral control', () => {
    const r = rule('.lu-tonal')
    expect(r).toContain('height: var(--control-h-sm)')
    expect(r).toContain('border-radius: var(--radius-control)')
  })

  it('a disabled tonal button loses its colour', () => {
    expect(rule('.lu-tonal:disabled')).toMatch(/grayscale/)
  })

  it('the accent is not spelled as a literal in the models folder', () => {
    // The tokens are the source. A hex here would be a second one.
    for (const f of ['ModelTiles.tsx', 'MacMediaTile.tsx', 'MacMediaLane.tsx', 'ModelManager.tsx', 'ModelCard.tsx', 'ModelPageParts.tsx', 'skin/mac.tsx']) {
      const src = readFileSync(resolve(__dirname, '..', f), 'utf8')
      expect(src, f).not.toMatch(/#a094f8|#5746d9|#8b7cf0/i)
    }
  })

  it('every card of the page lies on the one surface', () => {
    // The installed row takes its surface from the face of the page since
    // 08.10.2026 (the redesign is the Mac's alone), so the row's surface is
    // read where the Mac face spells it, and the row must really ask the face.
    for (const f of ['ModelTiles.tsx', 'MacMediaTile.tsx', 'skin/mac.tsx', 'LoraManager.tsx']) {
      expect(readFileSync(resolve(__dirname, '..', f), 'utf8'), f).toContain('lu-tile')
    }
    expect(readFileSync(resolve(__dirname, '..', 'skin', 'mac.tsx'), 'utf8'))
      .toMatch(/row: \(isActive\) => `lu-tile [^`]*\$\{isActive \? 'lu-tile--active' : ''\}`/)
    expect(readFileSync(resolve(__dirname, '..', 'ModelCard.tsx'), 'utf8')).toContain('className={look.row(isActive)}')
    expect(readFileSync(resolve(SRC, 'components', 'layout', 'ViewSkeletons.tsx'), 'utf8')).toContain('lu-tile pointer-events-none')
  })

  it('the classic face of Windows and Linux takes its colours from the same recipes', () => {
    // Since 10.10.2026 the classic build wears the Mac's colours. The
    // contrast figures above are computed on `.lu-tile` and `.lu-tonal`, so
    // they hold for the classic tile only as long as it really stands on
    // those two and writes no grey chain of its own beside them.
    const code = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const tiles = code('skin/ClassicTiles.tsx')
    expect(tiles).toMatch(/export const TILE_ACTION = 'lu-tonal'/)
    expect(tiles).toMatch(/export const TILE_CONTROL = 'lu-control lu-control--outline'/)
    expect((tiles.match(/'lu-tile (?:lu-tile--lead )?relative p-3'|"lu-tile relative p-3 /g) ?? []).length).toBe(3)
    expect(code('skin/classic.tsx')).toMatch(/row: \(isActive\) => `lu-tile [^`]*\$\{isActive \? 'lu-tile--active' : ''\}`/)
    expect(code('skin/ClassicLoraManager.tsx')).toContain('lu-tile ')
    for (const f of ['skin/classic.tsx', 'skin/ClassicTiles.tsx', 'skin/ClassicLoraManager.tsx']) {
      // The colours the classic face used to spell by hand are gone.
      expect(code(f), f).not.toMatch(/blue-\d|purple-\d|green-\d|red-500\/20|hover:text-red-|bg-gray-900|bg-white dark:bg-white\/10|shadow-sm/)
    }
  })
})
