import { describe, it, expect } from 'vitest'
import { itemHasAlpha, supportsTransparent, transparentPrompt, wantsTransparent } from '../transparent-image'

describe('Transparent background: der Prompt', () => {
  it('umhuellt den Prompt wie die offizielle Vorlage es schreibt', () => {
    expect(transparentPrompt('a red apple')).toBe(
      'This is an RGBA format image with transparency. a red apple. The image has an alpha channel and a transparent background.',
    )
  })

  it('ein Schlusspunkt oder Leerraum des Nutzers wird nicht verdoppelt', () => {
    expect(transparentPrompt('  a red apple.  ')).toBe(transparentPrompt('a red apple'))
    expect(transparentPrompt('a red apple...')).toBe(transparentPrompt('a red apple'))
  })

  it('kein Gedankenstrich im Satz, der an das Modell geht', () => {
    expect(transparentPrompt('x')).not.toMatch(new RegExp('[\\u2014\\u2013]'))
  })
})

describe('Transparent background: welche Modelle', () => {
  it('nur Qwen-Image 2.1, dessen VAE vier Kanaele schreibt', () => {
    expect(supportsTransparent('qwenimage')).toBe(true)
    for (const t of ['qwenimage1', 'flux', 'flux2', 'zimage', 'sdxl', 'sd15', 'chroma', 'unknown', '', null, undefined]) {
      expect(supportsTransparent(t as string)).toBe(false)
    }
  })

  it('nur ein lokaler Text-zu-Bild-Lauf fragt danach', () => {
    const run = { enabled: true, intent: 'image', isImageToImage: false, isSpecializedLane: false, modelType: 'qwenimage' }
    expect(wantsTransparent(run)).toBe(true)
    expect(wantsTransparent({ ...run, enabled: false })).toBe(false)
    expect(wantsTransparent({ ...run, intent: 'edit' })).toBe(false)
    expect(wantsTransparent({ ...run, intent: 'video' })).toBe(false)
    expect(wantsTransparent({ ...run, isImageToImage: true })).toBe(false)
    expect(wantsTransparent({ ...run, isSpecializedLane: true })).toBe(false)
    expect(wantsTransparent({ ...run, modelType: 'flux' })).toBe(false)
  })
})

describe('Transparent background: die Galerie', () => {
  it('ein Ausschnitt und ein transparentes Bild liegen auf dem Karomuster, ein anderes nicht', () => {
    expect(itemHasAlpha({ intent: 'removebg' })).toBe(true)
    expect(itemHasAlpha({ transparent: true })).toBe(true)
    expect(itemHasAlpha({ intent: 'image' })).toBe(false)
    expect(itemHasAlpha({})).toBe(false)
  })
})
