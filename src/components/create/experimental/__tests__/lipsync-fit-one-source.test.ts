import { describe, it, expect } from 'vitest'
import { lipsyncFitLine } from '../lipsyncFit'
import { getLipsyncBundles } from '../../../../api/model-bundles'
import { vramFit, vramFitLine } from '../../../../lib/vram-fit'

// The box, 03.10.2026: the talking character stage said "Comfortable on 12 GB
// VRAM", the card of the same bundle in the Model Manager said "Tight on your
// 12 GB card". The stage now says what the card says, from the same rule.
describe('the talking character stage and its Model Manager card', () => {
  const bundle = getLipsyncBundles()[0]

  it('say the same thing about a 12 GB card', () => {
    expect(bundle.name).toBe('Wan 2.2 S2V Q4 (Talking Character, GGUF)')
    expect(lipsyncFitLine(12)).toBe(' Tight on your 12 GB card: runs, loading can be slow.')
    expect(lipsyncFitLine(12).trim()).toBe(`${vramFitLine(vramFit(bundle, 12), 12)}.`)
  })

  it('agree on every other card too', () => {
    for (const card of [6, 8, 16, 24]) {
      expect(lipsyncFitLine(card).trim(), `${card} GB`).toBe(`${vramFitLine(vramFit(bundle, card), card)}.`)
    }
    expect(lipsyncFitLine(8)).toContain('Needs more than your 8 GB card')
    expect(lipsyncFitLine(16)).toContain('Fits your 16 GB card')
  })

  it('without a detected card the stage states what the bundle needs', () => {
    expect(lipsyncFitLine(null)).toBe(' Runs from 10 GB. Loads fully into graphics memory from 14.4 GB.')
  })
})
