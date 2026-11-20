/**
 * Wie ein Eintrag der Galerie heisst.
 *
 * Befund von 19.09.2026: "Danach kommt nur noch Cloud-Videos. Man kann
 * gar nicht mehr identifizieren, welches Video denn was ist." Zwei Ursachen,
 * beide hier festgenagelt: ein Eintrag ohne Prompt hatte ueberhaupt keinen
 * Namen, und ein Preset-Ergebnis sagte nicht, aus welchem Preset es kam.
 *
 * Port aus the web app.
 */
import { describe, expect, it } from 'vitest'
import { galleryLabel, galleryLabelShort } from '../gallery-label'
import type { GalleryItem } from '../../../stores/createStore'

const eintrag = (teil: Partial<GalleryItem>): GalleryItem => ({
  id: 'x', type: 'video', filename: '', subfolder: '', prompt: '', negativePrompt: '',
  model: 'wan-2.2-realism', modelType: 'unknown', seed: 0, steps: 0, cfgScale: 0,
  sampler: '', scheduler: '', width: 0, height: 0, batchSize: 1, createdAt: 0, ...teil,
})

describe('the name of a gallery entry', () => {
  it('never falls back to a name that fits every entry', () => {
    // Genau das war der Fehler: "Cloud video" stand ueber allem.
    const ohneAlles = eintrag({ model: 'gibt-es-nicht' })
    expect(galleryLabel(ohneAlles)).toBe('Clip')
    expect(galleryLabel(eintrag({}))).toBe('Clip · Wan 2.2 Realism')
    expect(galleryLabel(eintrag({ type: 'audio', model: 'gibt-es-nicht' }))).toBe('Audio')
  })

  it('shows the prompt when there is one', () => {
    expect(galleryLabel(eintrag({ prompt: 'a red fox trotting through fresh snow' })))
      .toBe('a red fox trotting through fresh snow')
  })

  it('puts the run and the prompt side by side, so one preset run is not the other', () => {
    expect(galleryLabel(eintrag({ label: 'Horror Creature', prompt: 'a gaunt figure' })))
      .toBe('Horror Creature · a gaunt figure')
  })

  it('names a run that has no prompt at all after what it did', () => {
    expect(galleryLabel(eintrag({ label: 'Extended clip' }))).toBe('Extended clip')
    expect(galleryLabel(eintrag({ intent: 'upscale', model: 'flashvsr' })))
      .toBe('Upscaled · FlashVSR')
  })

  it('never repeats itself when the two say the same', () => {
    expect(galleryLabel(eintrag({ label: 'Track', prompt: 'Track' }))).toBe('Track')
  })

  it('shortens to one line and only then marks the cut', () => {
    const lang = eintrag({ prompt: 'x'.repeat(80) })
    expect(galleryLabelShort(lang)).toHaveLength(41)
    expect(galleryLabelShort(lang).endsWith('…')).toBe(true)
    expect(galleryLabelShort(eintrag({ prompt: 'kurz' }))).toBe('kurz')
  })
})
