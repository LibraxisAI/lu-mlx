// Wie die Waehler Modelle ordnen und kennzeichnen (02.10.2026), und was
// sie mit einem Modell tun, das keine Stufe traegt.
//
// Der Desktop liest seinen Katalog vom Server, und ein aelterer Server liefert
// `tier` und `weights` nicht. Ein lokales ComfyUI-Modell hat noch keine Stufe.
// Beides muss neutral aussehen: Reihenfolge wie bisher, keine Marke, keine
// Zwischenzeile.

import { describe, expect, it } from 'vitest'
import { OLDER_GROUP, OTHER_GROUP, groupForPicker, mediaFamily, sortByTier, tierGroup, tierMarks, tierOf, weightsOf } from '../model-tier'

describe('Stufe und Herkunft', () => {
  it('sortByTier stellt best nach oben und older nach unten, sonst bleibt die Reihenfolge', () => {
    const liste = [
      { id: 'a', tier: 'older' as const }, { id: 'b', tier: 'standard' as const }, { id: 'c', tier: 'best' as const },
      { id: 'd', tier: 'standard' as const }, { id: 'e', tier: 'older' as const }, { id: 'f', tier: 'best' as const },
    ]
    const kopie = [...liste]
    expect(sortByTier(liste).map((m) => m.id)).toEqual(['c', 'f', 'b', 'd', 'a', 'e'])
    expect(liste).toEqual(kopie)
    expect(sortByTier(liste)).toHaveLength(liste.length)
  })

  it('nur die aelteren stehen unter einer Zwischenzeile', () => {
    expect(tierGroup({ tier: 'older' })).toBe(OLDER_GROUP)
    expect(OLDER_GROUP).toBe('Older models')
    expect(tierGroup({ tier: 'best' })).toBeUndefined()
    expect(tierGroup({ tier: 'standard' })).toBeUndefined()
  })

  it('die Marken: Best fuer best, Open weights nur fuer open, Open family fuer open-family, sonst nichts', () => {
    expect(tierMarks({ tier: 'best', weights: 'open' }).map((m) => m.label)).toEqual(['Best', 'Open weights'])
    expect(tierMarks({ tier: 'best', weights: 'open-family' }).map((m) => m.label)).toEqual(['Best', 'Open family'])
    expect(tierMarks({ tier: 'standard', weights: 'open-family' }).map((m) => m.label)).toEqual(['Open family'])
    expect(tierMarks({ tier: 'best', weights: 'closed' }).map((m) => m.label)).toEqual(['Best'])
    expect(tierMarks({ tier: 'older', weights: 'open' }).map((m) => m.label)).toEqual(['Open weights'])
    expect(tierMarks({ tier: 'standard', weights: 'closed' })).toEqual([])
  })
})

describe('ein Modell ohne Stufe und Herkunft ist neutral (alter Server, lokales Modell)', () => {
  it('gilt als standard und closed', () => {
    expect(tierOf({})).toBe('standard')
    expect(weightsOf({})).toBe('closed')
  })

  it('traegt keine Marke und steht unter keiner Zwischenzeile', () => {
    expect(tierMarks({})).toEqual([])
    expect(tierGroup({})).toBeUndefined()
  })

  it('behaelt seine Reihenfolge, auch gemischt mit Modellen, die eine Stufe haben', () => {
    const liste: { id: string; tier?: 'best' | 'standard' | 'older' }[] = [
      { id: 'a' }, { id: 'b', tier: 'older' }, { id: 'c' }, { id: 'd', tier: 'best' }, { id: 'e' },
    ]
    expect(sortByTier(liste).map((m) => m.id)).toEqual(['d', 'a', 'c', 'e', 'b'])
    // Ganz ohne Stufen aendert sich nichts.
    const ohne = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    expect(sortByTier(ohne).map((m) => m.id)).toEqual(['x', 'y', 'z'])
  })

  it('ein Wert, den es nicht gibt, gilt wie ein fehlender (ein kuenftiger Server mit neuer Stufe)', () => {
    const fremd = { tier: 'legendary' as never, weights: 'secret' as never }
    expect(tierOf(fremd)).toBe('standard')
    expect(weightsOf(fremd)).toBe('closed')
    expect(tierMarks(fremd)).toEqual([])
  })
})

// 05.10.2026: die Cloud-Waehler in Create gruppieren nach Familie, mit
// denselben einzeiligen Koepfen wie die Modellauswahl im Chat. Der Entscheid
// vom 02.10. (Beste oben, Aeltere gesammelt unten) gilt daneben weiter.
describe('mediaFamily', () => {
  it('liest die Familie aus dem ersten Wort, ohne Versionsanhang', () => {
    expect(mediaFamily('FLUX 3 Upscale')).toBe('FLUX')
    expect(mediaFamily('FLUX.2 Dev')).toBe('FLUX')
    expect(mediaFamily('Flux Schnell (fast)')).toBe('Flux')
    expect(mediaFamily('Qwen3 TTS')).toBe('Qwen')
    expect(mediaFamily('Qwen Image 3.0')).toBe('Qwen')
    expect(mediaFamily('LTX-2')).toBe('LTX')
    expect(mediaFamily('LTX 2.5')).toBe('LTX')
    expect(mediaFamily('Z-Image Turbo (fast)')).toBe('Z-Image')
    expect(mediaFamily('HunyuanImage 2.1')).toBe('Hunyuan')
    expect(mediaFamily('HunyuanVideo')).toBe('Hunyuan')
  })
})

describe('groupForPicker', () => {
  const m = (label: string, tier?: 'best' | 'standard' | 'older') => ({ label, ...(tier ? { tier } : {}) })
  const zeilen = (liste: { label: string }[]) => groupForPicker(liste).map((e) => `${e.group ?? '-'}: ${e.model.label}`)

  it('stellt Familien mit einem Besten nach vorn, in jeder Gruppe die Besten zuerst', () => {
    expect(zeilen([
      m('Wan 2.6'), m('FLUX 2'), m('Qwen Image 3.0', 'best'), m('Wan 3.0', 'best'), m('Qwen Image 2.1'), m('FLUX 3 Upscale', 'best'),
    ])).toEqual([
      'Qwen: Qwen Image 3.0', 'Qwen: Qwen Image 2.1',
      'Wan: Wan 3.0', 'Wan: Wan 2.6',
      'FLUX: FLUX 3 Upscale', 'FLUX: FLUX 2',
    ])
  })

  it('fasst Gross- und Kleinschreibung zu einer Familie, der Kopf traegt die Schreibweise des ersten', () => {
    expect(zeilen([m('FLUX 3 Upscale', 'best'), m('Flux Schnell'), m('Seedream 5'), m('Seedream 4')]))
      .toEqual(['FLUX: FLUX 3 Upscale', 'FLUX: Flux Schnell', 'Seedream: Seedream 5', 'Seedream: Seedream 4'])
  })

  it('gibt einer Familie mit einem einzigen Modell keinen Kopf: sie steht unter Other, zuletzt vor den Aelteren', () => {
    expect(zeilen([m('Chroma'), m('Wan 3.0', 'best'), m('Wan 2.6'), m('HiDream', 'older'), m('Sonilo')])).toEqual([
      'Wan: Wan 3.0', 'Wan: Wan 2.6',
      `${OTHER_GROUP}: Chroma`, `${OTHER_GROUP}: Sonilo`,
      `${OLDER_GROUP}: HiDream`,
    ])
  })

  it('sammelt die Aelteren am Ende, auch wenn ihre Familie oben einen Kopf hat', () => {
    const liste = groupForPicker([m('Wan 2.2', 'older'), m('Wan 3.0', 'best'), m('Wan 2.6'), m('LTX 2.3', 'older')])
    expect(liste.map((e) => e.group)).toEqual(['Wan', 'Wan', OLDER_GROUP, OLDER_GROUP])
    expect(liste.slice(-2).map((e) => e.model.label)).toEqual(['Wan 2.2', 'LTX 2.3'])
  })

  it('laesst den Kopf ganz weg, wenn es nur eine einzige Gruppe gibt', () => {
    expect(zeilen([m('Standard'), m('FlashVSR')])).toEqual(['-: Standard', '-: FlashVSR'])
    expect(zeilen([m('Wan 3.0', 'best'), m('Wan 2.6')])).toEqual(['-: Wan 3.0', '-: Wan 2.6'])
  })

  it('verliert kein Modell, verdoppelt keines und laesst die Eingabe unberuehrt', () => {
    const eingabe = [m('Wan 2.6'), m('FLUX 3 Upscale', 'best'), m('HiDream', 'older'), m('Wan 3.0', 'best'), m('Nucleus')]
    const kopie = eingabe.map((x) => x.label)
    const aus = groupForPicker(eingabe).map((e) => e.model.label)
    expect([...aus].sort()).toEqual([...kopie].sort())
    expect(eingabe.map((x) => x.label)).toEqual(kopie)
  })

  it('gruppiert auch gegen einen Server ohne Stufen, in der Reihenfolge des Katalogs', () => {
    expect(zeilen([m('Wan 2.6'), m('FLUX 2'), m('Wan 2.2'), m('FLUX 1')]))
      .toEqual(['Wan: Wan 2.6', 'Wan: Wan 2.2', 'FLUX: FLUX 2', 'FLUX: FLUX 1'])
  })
})

describe('die Marken im Etiketten-Stil der Waehler', () => {
  it('"Best" traegt den einen Akzent, die Herkunft steht ohne Ton', () => {
    expect(tierMarks({ tier: 'best', weights: 'open' })).toEqual([{ label: 'Best', tone: 'accent' }, { label: 'Open weights' }])
    expect(tierMarks({ tier: 'standard', weights: 'open-family' })).toEqual([{ label: 'Open family' }])
    expect(tierMarks({})).toEqual([])
  })
})
