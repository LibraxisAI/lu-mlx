/**
 * Der Kommentar "MiniMax H3's audio autoencoder" stand ueber isLtx25File
 * (Opus-Endpruefung 02.10.2026). Jede dieser Funktionen traegt den Kommentar,
 * der von ihr handelt, und keinen fremden.
 *
 * Run: npx vitest run src/api/__tests__/jsdoc-sits-on-its-own-function.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'src/api/comfyui.ts'), 'utf8')

/** The JSDoc block(s) directly above `export ... name(`. */
function docAbove(name: string): string {
  const at = src.search(new RegExp(`export (async )?function ${name}\\b`))
  expect(at, name).toBeGreaterThan(0)
  let end = at
  let out = ''
  // Walk upwards over the comment blocks that touch the function.
  for (;;) {
    const before = src.slice(0, end).trimEnd()
    if (!before.endsWith('*/')) break
    const start = before.lastIndexOf('/**')
    if (start < 0) break
    out = before.slice(start) + out
    end = start
  }
  return out
}

describe('JSDoc in comfyui.ts', () => {
  it('isLtx25File traegt nur seinen eigenen Kommentar', () => {
    const d = docAbove('isLtx25File')
    expect(d).toMatch(/LTX 2\.5/)
    expect(d).not.toMatch(/MiniMax/)
  })

  it('findMiniMaxAudioVAE traegt den MiniMax-Kommentar', () => {
    expect(docAbove('findMiniMaxAudioVAE')).toMatch(/MiniMax H3's audio autoencoder/)
  })

  it('findLtx25AudioVAE traegt den LTX-Kommentar', () => {
    const d = docAbove('findLtx25AudioVAE')
    expect(d).toMatch(/LTX 2\.5/)
    expect(d).not.toMatch(/MiniMax/)
  })
})
