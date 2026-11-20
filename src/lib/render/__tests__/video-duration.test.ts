/**
 * Portiert aus dem Web (P1, Vertrag), dd29f359. Der Web-Fall "covers every
 * advertised classic video and has a price for every long choice" haengt an
 * der Preistabelle des Servers, die es im Desktop
 * nicht gibt (Preise kommen aus dem Katalog, nicht aus einer eigenen Tabelle).
 * Diese Deckung gehoert in P3, sobald CloudModel.clip.durations im
 * Desktop-Katalogtyp steht.
 *
 * Der Web-Fall "keeps the worker contract byte-identical to the API
 * contract" vergleicht API- gegen Worker-Kopie im selben Repo; dafuer gibt es
 * im Desktop keine Entsprechung. Stattdessen haelt der Fall unten
 * video-durations.json byteidentisch gegen den Web-Worktree, wenn
 * LU_WEB_REPO gesetzt ist, und ueberspringt sonst sauber.
 *
 * Run mit Drift-Pruefung: LU_WEB_REPO=/pfad/zum/web npx vitest run \
 *   src/lib/render/__tests__/video-duration.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bookedVideoSeconds, effectiveVideoDurations, videoDurations } from '../video-duration'
import durations from '../video-durations.json'
import endpoints from '../provider-endpoints.json'
import schemas from '../provider-schemas.json'
import { CLOUD_MODEL_SEED } from '../cloud-models'
import { webCheckout } from '../../__tests__/web-checkout'

const WEB = webCheckout('video-duration', ['apps/web/lib/render/video-durations.json'])

describe('priced video duration contract', () => {
  describe.skipIf(!WEB)('haelt video-durations.json byteidentisch gegen den Web-Worktree', () => {
    it('video-durations.json', () => {
      const desktop = readFileSync(resolve('src/lib/render/video-durations.json'), 'utf8')
      const web = readFileSync(resolve(WEB!, 'apps/web/lib/render/video-durations.json'), 'utf8')
      expect(desktop).toBe(web)
    })
  })

  it.each([0, -1, NaN, Infinity, '8'])('rejects invalid frame count %s', (frames) => {
    expect(() => bookedVideoSeconds('wan-2.2-720p', { frames, fps: 16 })).toThrow()
  })

  it('preserves older frame buckets only for supported lengths', () => {
    expect(bookedVideoSeconds('wan-2.2-720p', { frames: 121, fps: 16 })).toBe(8)
    expect(() => bookedVideoSeconds('wan-2.7-spicy', { frames: 121, fps: 16 })).toThrow()
    expect(bookedVideoSeconds('wan-2.7-spicy', { duration: 10 })).toBe(10)
    expect(bookedVideoSeconds('wan-2.7-spicy', { frames: 120, fps: 8 })).toBe(15)
    expect(() => bookedVideoSeconds('missing', {})).toThrow()
  })

  // Fund F3 (05.10.2026): Wan 2.2 Fast bot "8s" an und buchte dafuer mehr, sein
  // Endpunkt kennt aber kein Feld fuer die Dauer. Jede Laenge, die die
  // Oberflaeche anbietet, muss jeder Endpunkt des Modells auch annehmen.
  it('jede angebotene Laenge nimmt jeder Endpunkt des Modells an', () => {
    type Field = { enum?: number[]; minimum?: number; maximum?: number }
    const schemaOf = (path: string) => (schemas as unknown as Record<string, { properties: Record<string, Field> }>)[path]
    for (const [model, lengths] of Object.entries(durations as Record<string, number[]>)) {
      const paths = Object.values((endpoints as unknown as Record<string, Record<string, string>>)[model])
      expect(paths.length, model).toBeGreaterThan(0)
      for (const path of paths) {
        const field = schemaOf(path)?.properties.duration
        if (!field) {
          // Kein Feld fuer die Dauer: es gibt genau eine Laenge.
          expect(lengths, `${model} ${path}`).toHaveLength(1)
          continue
        }
        for (const seconds of lengths) {
          const ok = field.enum
            ? field.enum.includes(seconds)
            : seconds >= (field.minimum ?? seconds) && seconds <= (field.maximum ?? seconds)
          expect(ok, `${model} ${path} ${seconds}s`).toBe(true)
        }
      }
    }
  })

  it('Wan 2.2 Fast hat eine Laenge, in der Liste wie im Notvorrat des Katalogs', () => {
    expect(videoDurations('wan-2.2-fast')).toEqual([5])
    expect(effectiveVideoDurations('wan-2.2-fast')).toEqual([5])
    expect(CLOUD_MODEL_SEED.find((m) => m.id === 'wan-2.2-fast')?.clip).toEqual({ short: 5 })
    expect(() => bookedVideoSeconds('wan-2.2-fast', { frames: 128, fps: 16 })).toThrow()
  })

  it('exposes the durations file directly, since P3 does not wire CLOUD_MODELS yet', () => {
    expect(videoDurations('wan-2.2-720p')).toEqual([5, 8])
    expect(videoDurations('missing')).toEqual([])
  })
})
