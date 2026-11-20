/**
 * Kein Studio-Modell darf ein Feld anbieten, das der Anbieter je Ergebnis
 * berechnet, waehrend der Worker nur outputs[0] nimmt (Befund 02.10.2026:
 * nucleus-image num_images, der Kunde zahlte zwei und bekam ein Bild). Mehrere
 * Ergebnisse gibt es nur ueber mehrere Auftraege (count in /api/jobs).
 */
import { describe, it, expect } from 'vitest'
import { STUDIO_MODELS, studioCredits, studioFields, studioOptions, studioSchema } from '../studio-contract'

const MULTI_OUTPUT = /^(num_(images|outputs|videos|results|generations|samples)|n|batch_size|batch|count|samples|variations|number_of_\w+|max_images|output_count)$/i

describe('Studio-Katalog: keine Mehrfach-Ergebnis-Felder', () => {
  const ids = Object.keys(STUDIO_MODELS)
  it('der Katalog ist nicht leer', () => { expect(ids.length).toBeGreaterThan(50) })

  it.each(ids)('%s bietet kein Mehrfach-Ergebnis-Feld an', (id) => {
    for (const [key, schema] of Object.entries(studioSchema(id).properties ?? {})) {
      if (!MULTI_OUTPUT.test(key)) continue
      expect(schema.disabled, `${id}.${key} muss disabled sein`).toBe(true)
      expect(studioFields(id)[key], `${id}.${key} steht in den Optionen`).toBeUndefined()
      // Nie in den Optionen: der Worker prueft sie erneut gegen dieselben Felder.
      expect(studioOptions(id, 'x', {}, false)[key], `${id}.${key}`).toBeUndefined()
      expect(schema.default ?? 1, `${id}.${key} Standard des Anbieters`).toBe(1)
      expect(() => studioOptions(id, 'x', { [key]: 2 }, false)).toThrow()
    }
  })

  it('ein Preisfaktor aus so einem Feld rechnet mit genau einem Ergebnis', () => {
    for (const id of ids) {
      const f = STUDIO_MODELS[id].price.perUnitField
      if (f && MULTI_OUTPUT.test(f)) {
        const o = studioOptions(id, 'x', {}, false)
        expect(studioCredits(id, o)).toBe(studioCredits(id, { ...o, [f]: 1 }))
      }
    }
  })
})
