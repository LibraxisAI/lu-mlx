import { describe, it, expect, beforeEach } from 'vitest'
import { useCloudCatalogStore, runCredits } from '../cloudCatalogStore'
import { CLOUD_MODEL_SEED } from '../../lib/render/cloud-models'
import type { CloudCatalog } from '../../api/cloud/catalog'

// P3: der Preisfall fuer den Studio-Zweig und by_duration in runCredits().
//
// Studio-Modelle duerfen NIE aus dieser Funktion einen Preis bekommen: der
// Anbieter bestaetigt ihn live ueber studioQuote() (src/api/cloud/studio.ts),
// alles andere waere die zweite Preiswahrheit, vor der Portplan Abschnitt 7
// (Risiko 1) warnt. by_duration lohnt sich, sobald der Katalog eine Laenge
// fuehrt, die weder die kurze noch die lange Stufe ist.

const studioCatalog: CloudCatalog = {
  models: [
    {
      id: 'preset-horror',
      label: 'Horror Creature',
      kind: 'image',
      quote_required: true,
      pricing: { mode: 'output', rates: { default: 0.02 } },
    },
    {
      id: 'wan-9',
      label: 'Wan 9',
      kind: 'video',
      clip: { short: 5, long: 8, durations: [3, 5, 8, 10] },
      credits: { base: 8000, long: 13000, by_duration: { '3': 4800, '5': 8000, '8': 13000, '10': 16200 } },
    },
  ],
  ops: {
    removebg: 1000,
    eraser: 2500,
    upscale_image: 1000,
    upscale_video_per_s: 500,
    upscale_video_min: 2500,
  },
  voice: { stt: 600, tts_per_1k_chars: 8000 },
  media_live: true,
  tier: 'hosted-max',
  monthly_credits: 2_550_000,
}

beforeEach(() => {
  useCloudCatalogStore.setState({
    fetchedAt: null,
    models: CLOUD_MODEL_SEED,
    ops: null,
    voice: null,
    mediaLive: null,
  })
})

describe('runCredits, Studio-Zweig', () => {
  it('never prices a quote_required model itself, it returns the caller-supplied fallback', () => {
    useCloudCatalogStore.getState().setCatalog(studioCatalog)
    // Negativkontrolle: ein erfundener, klar unterscheidbarer Fallback-Wert.
    // Kaeme runCredits doch bei einer eigenen Formel heraus, waere die Zahl
    // hier so gut wie sicher eine andere als 777777.
    expect(runCredits('image', 'generate', 'preset-horror', undefined, 777_777)).toBe(777_777)
  })

  it('a classic model right next to a Studio one in the same catalog still prices normally', () => {
    useCloudCatalogStore.getState().setCatalog(studioCatalog)
    expect(runCredits('video', 'generate', 'wan-9', 5, 1)).toBe(8000)
  })

  // P9: the guard used to sit before every op branch, so a Studio-originated
  // video reaching the gallery Lightbox's separate "Sharpen/Enhance" action
  // (Lightbox.tsx: runCredits('video', 'upscale', item.model, ...)) fell
  // through to the caller's fallback too, hiding the real per-second
  // render-service rate for a wholly unrelated endpoint. The guard now sits only
  // in front of the generic model-credits branch it was written to protect;
  // 'upscale'/'eraser'/'removebg'/'music' price from the flat `ops` table or
  // their own per_s/base fields, never from a Studio model's own formula, so
  // they must stay reachable even for a quote_required model.
  it('a Studio-originated video still prices the classic video-upscale enhance action', () => {
    useCloudCatalogStore.getState().setCatalog(studioCatalog)
    expect(runCredits('video', 'upscale', 'preset-horror', 8, 777_777)).toBe(4000)
  })
})

describe('runCredits, by_duration', () => {
  it('prices an exact catalog length precisely, not rounded onto short/long', () => {
    useCloudCatalogStore.getState().setCatalog(studioCatalog)
    expect(runCredits('video', 'generate', 'wan-9', 3, 1)).toBe(4800)
    expect(runCredits('video', 'generate', 'wan-9', 10, 1)).toBe(16200)
  })

  it('falls back to the base/long split for a length the by_duration table does not carry', () => {
    useCloudCatalogStore.getState().setCatalog(studioCatalog)
    // 6 ist im Katalog nicht gelistet: weder kurz (5) noch die Schwelle 6.5
    // fuer "long" erreicht, also der Basissatz.
    expect(runCredits('video', 'generate', 'wan-9', 6, 1)).toBe(8000)
  })

  it('an older catalog without by_duration keeps the pre-P3 base/long behaviour', () => {
    useCloudCatalogStore.setState({
      models: [
        { id: 'wan-old', label: 'Wan Old', kind: 'video', clip: { short: 5, long: 8 }, credits: { base: 8000, long: 13000 } },
      ],
    })
    expect(runCredits('video', 'generate', 'wan-old', 5, 1)).toBe(8000)
    expect(runCredits('video', 'generate', 'wan-old', 8, 1)).toBe(13000)
  })
})
