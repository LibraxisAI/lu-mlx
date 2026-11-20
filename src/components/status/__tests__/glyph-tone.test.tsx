/**
 * The letters of the sign always have a colour of their own. In the window of
 * computer control they were given only a layout class, lost their colour
 * with it and came out black on the dark panel (owner, 09.10.2026).
 *
 * Run: npx vitest run src/components/status/__tests__/glyph-tone.test.tsx
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { StatusGlyph } from '../StatusGlyph'

const here = dirname(fileURLToPath(import.meta.url))
const rootClass = (html: string): string => /data-testid="status-glyph"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? /class="([^"]*)"[^>]*data-testid="status-glyph"/.exec(html)?.[1] ?? ''

describe('the colour of the letters in the sign', () => {
  it('a layout class does not take the colour away', () => {
    const html = renderToStaticMarkup(<StatusGlyph kind="approval" className="shrink-0" />)
    expect(rootClass(html)).toContain('text-lu-accent')
    expect(rootClass(html)).toContain('shrink-0')
  })

  it('tone "edge" draws the letters in the colour of the frame', () => {
    const html = renderToStaticMarkup(<StatusGlyph kind="approval" tone="edge" className="shrink-0" />)
    const frame = /data-part="c0"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? /class="([^"]*)"[^>]*data-part="c0"/.exec(html)?.[1]
    expect(frame).toBeTruthy()
    expect(rootClass(html).split(' ')).toContain(frame)
    expect(rootClass(html)).not.toContain('accent')
  })

  it('every sign in the window of computer control uses the edge tone', () => {
    for (const file of ['../../computer/ComputerSurface.tsx', '../../computer/ComputerQuestion.tsx']) {
      const source = readFileSync(resolve(here, file), 'utf8')
      const signs = source.match(/<StatusGlyph[^>]*>/g) ?? []
      expect(signs.length).toBeGreaterThan(0)
      for (const sign of signs) expect(sign).toContain('tone="edge"')
    }
  })
})
