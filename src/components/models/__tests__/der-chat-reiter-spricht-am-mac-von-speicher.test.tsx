import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CapLegend, FitHint, HardwareChip, ModelTile, shortBlurb } from '../ModelTiles'
import { getMainstreamTextModels, getUncensoredTextModels, type DiscoverModel } from '../../../api/discover'

// 08.10.2026, the Mac Model Manager: the Chat rail read "32 GB GPU · 32 GB
// RAM", "Fits my PC", "Runs on your PC", "No GPU" and "fits a 12 GB card" on a
// machine that has one memory pool and no card. With `sharedMemory` the tile
// speaks of memory and of this Mac. Without it nothing changes.

const catalogue = [...getMainstreamTextModels(), ...getUncensoredTextModels()]
const group = (name: string): DiscoverModel[] => catalogue.filter((m) => (m.group ?? m.name) === name)

function tile(variants: DiscoverModel[], budgetGb: number | null, sharedMemory: boolean): string {
  return renderToStaticMarkup(
    <ModelTile
      variants={variants} vramGb={budgetGb} sharedMemory={sharedMemory}
      isInstalled={() => false} dlState={() => null}
      onDownload={() => {}} onInfo={() => {}} onOpenUrl={() => {}}
    />,
  )
}

const PC_WORDS = /your PC|GPU|VRAM|\bCPU\b|\d+ ?GB cards?\b/

describe('the chat tile on a Mac', () => {
  it('says "Runs on this Mac" where a PC reads "Runs on your PC"', () => {
    const variants = group('Qwen 3.8 27B')
    const mac = tile(variants, 45, true)
    expect(mac).toContain('Runs on this Mac')
    expect(mac).not.toMatch(PC_WORDS)
    const pc = tile(variants, 45, false)
    expect(pc).toContain('Runs on your PC')
    expect(pc).not.toContain('this Mac')
  })

  it('a model beyond the memory needs more memory, it does not "run on CPU"', () => {
    const variants = group('Qwen 3.8 27B')
    const mac = tile(variants, 4, true)
    expect(mac).toContain('Needs more memory')
    expect(mac).not.toContain('Runs on CPU')
    expect(tile(variants, 4, false)).toContain('Runs on CPU, slower')
  })

  it('a blurb that names a card names free memory instead', () => {
    const small = catalogue.find((m) => m.name === 'Qwen 3.8 27B UD-IQ2_XXS')!
    expect(shortBlurb(small)).toContain('8 GB card')
    expect(shortBlurb(small, true)).toBe('smallest dynamic quant, runs in 8 GB of free memory')
  })

  it('GUARD: no tile of the whole catalogue names PC hardware on a Mac', () => {
    const offenders = catalogue
      .map((m) => ({ name: m.name, html: tile([m], 22, true).replace(/<[^>]+>/g, ' ') }))
      .filter((x) => PC_WORDS.test(x.html))
      .map((x) => `${x.name}: ${x.html.match(PC_WORDS)![0]}`)
    expect(offenders).toEqual([])
  })

  it('COUNTER-CHECK: the same catalogue does name them on a PC', () => {
    expect(catalogue.filter((m) => PC_WORDS.test(tile([m], 22, false).replace(/<[^>]+>/g, ' '))).length).toBeGreaterThan(10)
  })
})

describe('the row above the tiles on a Mac', () => {
  it('the legend says Light where a PC says No GPU', () => {
    expect(renderToStaticMarkup(<CapLegend sharedMemory />)).toContain('Light')
    expect(renderToStaticMarkup(<CapLegend sharedMemory />)).not.toMatch(/GPU|CPU/)
    expect(renderToStaticMarkup(<CapLegend />)).toContain('No GPU')
  })

  it('the hardware chip shows one number, the memory', () => {
    const mac = renderToStaticMarkup(<HardwareChip vramGb={32} ramGb={32} sharedMemory />)
    expect(mac).toContain('32 GB memory')
    expect(mac).not.toMatch(/GPU|RAM/)
    expect(renderToStaticMarkup(<HardwareChip vramGb={12} ramGb={32} />)).toContain('12 GB GPU')
  })

  it('the verdict stays on one line', () => {
    expect(renderToStaticMarkup(<FitHint fit="fits" />)).toContain('whitespace-nowrap')
  })
})
