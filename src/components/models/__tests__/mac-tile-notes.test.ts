/**
 * A Mac media tile says "experimental", the licence and the token on the
 * tile itself (persona walk of the Mac app, 09.10.2026, Fund 16).
 *
 * Whoever fetched the 17 GB of Qwen-Image 2.1 saw neither "Experimental"
 * nor "non-commercial use only": both stood at the end of a description that
 * the tile cuts after two lines.
 *
 * Run: npx vitest run src/components/models/__tests__/mac-tile-notes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TILE_NOTES, splitTileNotes } from '../macTileNotes'

const rust = (file: string) => readFileSync(resolve(__dirname, '../../../../src-tauri/src/commands', file), 'utf-8')

/** Every description of the three Mac catalogues, as Rust writes them. */
function catalogueDescriptions(): string[] {
  const out: string[] = []
  for (const file of ['mlx.rs', 'image_mflux.rs', 'video.rs']) {
    const source = rust(file)
    const production = source.slice(0, source.indexOf('#[cfg(test)]') > 0 ? source.indexOf('#[cfg(test)]') : source.length)
    for (const m of production.matchAll(/^\s+description: "((?:[^"\\]|\\.)*)",?$/gm)) out.push(m[1].replace(/\\"/g, '"'))
  }
  return out
}

describe('a description taken apart', () => {
  it('Qwen-Image 2.1: the licence and "experimental" are marks, the text is what the model is', () => {
    const { text, notes } = splitTileNotes('Qwen-Image 2.1, quantized to 8-bit for the MLX image engine. Generates from a prompt and edits images from a prompt. Strong at text inside images. Research license, non-commercial use only. Experimental: not yet tested in LU.')
    expect(notes.map((n) => n.id)).toEqual(['non-commercial', 'experimental'])
    expect(notes.map((n) => n.label)).toEqual(['Non-commercial', 'Experimental'])
    expect(text).toBe('Qwen-Image 2.1, quantized to 8-bit for the MLX image engine. Generates from a prompt and edits images from a prompt. Strong at text inside images.')
  })

  it('LTX-2.5: the token is a mark', () => {
    const { text, notes } = splitTileNotes('The newest LTX generation in 4-bit, with its text encoder in the download. Its repository asks for a free Hugging Face token. Experimental: not yet tested in LU.')
    expect(notes.map((n) => n.label)).toEqual(['Needs a Hugging Face token', 'Experimental'])
    expect(text).toBe('The newest LTX generation in 4-bit, with its text encoder in the download.')
  })

  it('a description without such a sentence is left as it is', () => {
    const plain = 'Quick 512px drafts in 1 to 4 steps. The starter model, runs on every Apple Silicon Mac.'
    expect(splitTileNotes(plain)).toEqual({ text: plain, notes: [] })
  })

  it('the tooltip of a mark is the catalogue sentence', () => {
    for (const note of TILE_NOTES) expect(splitTileNotes(`A model. ${note.sentence}`).notes[0].sentence).toBe(note.sentence)
  })
})

describe('the catalogues in Rust', () => {
  const all = catalogueDescriptions()

  it('were read', () => {
    expect(all.length).toBeGreaterThan(50)
    expect(all.filter((d) => d.includes('Experimental: not yet tested in LU.')).length).toBeGreaterThan(20)
    expect(all.some((d) => d.includes('Research license, non-commercial use only.'))).toBe(true)
    expect(all.some((d) => d.includes('Its repository asks for a free Hugging Face token.'))).toBe(true)
  })

  it('the Qwen-Image 2.1 packs have run in LU and are no longer marked experimental', () => {
    // Real runs, 09.10.2026: text to image and edit on 4-bit, 8-bit and Turbo.
    const qwen = (bits: string) => all.filter((d) => d.startsWith(`Qwen-Image 2.1, quantized to ${bits} for the MLX image engine.`))
    expect(qwen('4-bit')).toHaveLength(1)
    expect(splitTileNotes(qwen('4-bit')[0]).notes.map((n) => n.id)).toEqual(['non-commercial'])
    expect(qwen('4-bit')[0]).toContain('for Macs from 16 GB')
    expect(qwen('8-bit')).toHaveLength(1)
    expect(splitTileNotes(qwen('8-bit')[0]).notes.map((n) => n.id)).toEqual(['non-commercial'])
    const turbo = all.filter((d) => d.startsWith('Qwen-Image 2.1 8-bit with the Viggle Turbo LoRA'))
    expect(turbo).toHaveLength(1)
    expect(splitTileNotes(turbo[0]).notes.map((n) => n.id)).toEqual(['non-commercial'])
  })

  it('say nothing about a licence, a token, a gate or being experimental that no mark carries', () => {
    const left: string[] = []
    for (const description of all) {
      const { text } = splitTileNotes(description)
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        if (/licen[sc]e|non-commercial|token|gated|experimental|not yet tested/i.test(sentence)) left.push(sentence)
      }
    }
    expect(left, 'a catalogue sentence a customer must see has no mark in macTileNotes.ts').toEqual([])
  })
})
