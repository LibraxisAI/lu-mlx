/**
 * Bild, Bearbeiten, Video und Animate fahren die neuen Studio-Modelle
 * (02.10.2026, Web-Paritaet; Vorlage: the web app).
 * Daran haengen Dinge, die still falsch
 * sein koennen: der Op, das Bild als Liste, keine Maske fuer Editoren per
 * Anweisung, keine klassischen Laengenfelder fuer ein Studio-Video, und
 * Enhance Image, das weiter den festen Endpunkt nimmt.
 *
 * Der letzte Block laeuft gegen den Katalog des Servers von heute: ein Modell,
 * das er nicht kennt, wird nicht gestartet, sondern auf den Standard gebogen.
 *
 * Nichts wird erzeugt: Absenden, Hochladen und Abholen sind gemockt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

// A full, hand-written mock (no `...actual` spread): the real ../../api/cloud/jobs
// pulls in the Supabase client (api/cloud/supabase.ts), which touches
// `localStorage` at import time and blows up outside a browser-like test
// environment. The established pattern in this directory (see
// useCloudCreate-b3-adult-gate-fires-before-upload.test.ts) is a fake
// CloudJobError/QuoteChangedError pair instead of the real classes.
const hoisted = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, meta?: { code?: string }) {
      super(message)
      this.status = status
      this.code = meta?.code
    }
  }
  class FakeQuoteChangedError extends FakeCloudJobError {
    credits: number
    constructor(message: string, credits: number) {
      super(message, 409, { code: 'quote_changed' })
      this.credits = credits
    }
  }
  const submitted: Array<{ kind: string; model: string; prompt: string; params: Record<string, unknown> }> = []
  const hochgeladen: string[] = []
  return {
    FakeCloudJobError,
    FakeQuoteChangedError,
    submitted,
    hochgeladen,
    uploadInput: vi.fn(async (_blob: unknown, slot: string) => {
      hochgeladen.push(slot)
      return `user-1/staged-${slot}.${slot === 'audio' ? 'mp3' : slot === 'video' ? 'mp4' : 'png'}`
    }),
    getJob: vi.fn(async () => ({ id: 'quelle', result_url: 'https://storage.example/clip.mp4' })),
    submitCloudJob: vi.fn(async (payload: (typeof submitted)[number]) => {
      submitted.push(payload)
      return { id: 'job-test', quota: { cost: 1000, used: 1000, limit: 100000 } }
    }),
    pollJob: vi.fn(async () => ({
      id: 'job-test', kind: 'video', model: 'longcat-avatar', status: 'succeeded',
      result_url: 'https://storage.example/out.mp4', created_at: new Date().toISOString(),
    })),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    studioQuote: vi.fn(async (..._args: unknown[]) => ({ credits: 42 })),
  }
})
const { submitted, hochgeladen } = hoisted

// Sidesteps loadContentPolicy's own call into ../../api/cloud/jobs
// (getContentPolicy). 'off' keeps clientSafety() to its CSAM-only floor,
// same as an account whose policy has not loaded yet.
vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))

vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: hoisted.uploadInput,
  getJob: hoisted.getJob,
  submitCloudJob: hoisted.submitCloudJob,
  pollJob: hoisted.pollJob,
  cancelJob: hoisted.cancelJob,
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChangedError,
}))

// Review A1/B3 (Runde 2): useCloudCreate now quotes a Studio run right
// before booking (see useCloudCreate.ts, the "Confirming the price…" step)
// and uses that number as max_credits. A fixed 42 keeps every existing
// assertion below about the OTHER params fields unaffected; the dedicated
// max_credits/quote_changed behavior gets its own tests further down.
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { alterServer, neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

const BILD = { filename: 'portrait.png', url: 'data:image/png;base64,AA', width: 512, height: 512 }

beforeEach(() => {
  submitted.length = 0
  hochgeladen.length = 0
  hoisted.studioQuote.mockClear()
  hoisted.studioQuote.mockResolvedValue({ credits: 42 })
  hoisted.submitCloudJob.mockClear()
  hoisted.submitCloudJob.mockImplementation(async (payload: (typeof submitted)[number]) => {
    submitted.push(payload)
    return { id: 'job-test', quota: { cost: 1000, used: 1000, limit: 100000 } }
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud',
    source: null, audioInput: null, videoInput: null, voiceFromJob: null,
    extendSource: null, gallery: [], cloudStudioOptions: {},
    // Review A kleiner Punkt 1 (Runde 3): explicit per test below, null here
    // so a leftover value from one test cannot leak a false block/pass into
    // the next.
    cloudStudioCredits: null,
  })
  useCreateStore.getState().setPrompt('a neutral placeholder line')
  // Review B1: this whole file simulates a server that already knows Studio
  // (that is what every test here submits against). Without `quote_required`
  // on the live catalog, `resolveIntentPick` would fall back to a CLASSIC
  // member for every one of these role intents (create-studio.test.ts has
  // the dedicated fallback coverage for the opposite state).
  useCloudCatalogStore.setState({ models: neuerServer() })
})


describe('die neuen Studio-Modelle in Bild, Bearbeiten, Video und Animate', () => {
  it('Bearbeiten: ein Studio-Editor startet ohne Maske und bekommt das Bild als Liste', async () => {
    const s = useCreateStore.getState()
    s.setIntent('edit')
    s.setCloudImageModel('qwen-image-2.1-edit')
    useCreateStore.setState({ source: BILD, mask: null })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].model).toBe('qwen-image-2.1-edit')
    expect(submitted[0].kind).toBe('image')
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.image_paths).toEqual(['user-1/staged-source.png'])
    // Dieses Modell liest kein source_path, also geht das Bild nur in die Liste.
    expect(submitted[0].params.source_path).toBeUndefined()
    expect(submitted[0].params.mask_path).toBeUndefined()
    expect(submitted[0].params.denoise).toBeUndefined()
    expect(hochgeladen).not.toContain('mask')
    // Die bestaetigte Zahl bekommt die Bilderliste mit, sonst rechnete der
    // Anbieter ohne Bild und der Deckel stimmte nicht.
    expect(hoisted.studioQuote).toHaveBeenCalledTimes(1)
    expect(hoisted.studioQuote.mock.calls[0][2]).toMatchObject({ image_paths: ['user-1/staged-source.png'] })
  })

  it('Bearbeiten: das maskierte flux-dev verlangt seine Maske weiter', async () => {
    const s = useCreateStore.getState()
    s.setIntent('edit')
    s.setCloudImageModel('flux-dev')
    useCreateStore.setState({ source: BILD, mask: null })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(0)
    expect(useCreateStore.getState().error).toMatch(/mask/i)
  })

  it('Bearbeiten: das klassische Qwen Image Edit startet ohne Maske', async () => {
    const s = useCreateStore.getState()
    s.setIntent('edit')
    s.setCloudImageModel('qwen-image-edit')
    useCreateStore.setState({ source: BILD, mask: null })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].model).toBe('qwen-image-edit')
    expect(submitted[0].params.op).toBe('edit')
    expect(submitted[0].params.mask_path).toBeUndefined()
  })

  it('Text zu Bild: ein neues Bildmodell geht als Studio-Lauf mit seinen Optionen', async () => {
    const s = useCreateStore.getState()
    s.setIntent('image')
    s.setCloudImageModel('qwen-image-2.1')
    s.setCloudStudioOptions({ resolution: '2k', aspect_ratio: '16:9' })
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('qwen-image-2.1')
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.studio_options).toEqual({ resolution: '2k', aspect_ratio: '16:9' })
    // Kein klassisches Feld rutscht in einen Studio-Lauf.
    expect(submitted[0].params.steps).toBeUndefined()
    expect(submitted[0].params.cfg).toBeUndefined()
  })

  it('Text zu Video: ein neues Videomodell schickt seine Laenge als Option, nie frames und fps', async () => {
    const s = useCreateStore.getState()
    s.setIntent('video')
    s.setCloudVideoModel('ltx-2.5-t2v')
    s.setCloudStudioOptions({ resolution: '1080p', duration: 10 })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted[0].model).toBe('ltx-2.5-t2v')
    expect(submitted[0].kind).toBe('video')
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.studio_options).toEqual({ resolution: '1080p', duration: 10 })
    expect(submitted[0].params.frames).toBeUndefined()
    expect(submitted[0].params.fps).toBeUndefined()
  })

  it('Text zu Video: ohne gespeicherte Wahl laeuft der neue Standard minimax-h3-t2v', async () => {
    const s = useCreateStore.getState()
    s.setIntent('video')
    s.setCloudVideoModel('')
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('minimax-h3-t2v')
    expect(submitted[0].params.op).toBe('studio')
  })

  it('Text zu Video: ein klassisches Modell bucht weiter seine Laenge als frames und fps', async () => {
    const s = useCreateStore.getState()
    s.setIntent('video')
    s.setCloudVideoModel('wan-2.2-720p')
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('wan-2.2-720p')
    expect(submitted[0].params.op).toBe('generate')
    expect(submitted[0].params.frames).toBe(80)
    expect(submitted[0].params.fps).toBe(16)
  })

  it('Animate: Bild zu Video als Studio-Lauf mit source_path', async () => {
    const s = useCreateStore.getState()
    s.setIntent('animate')
    s.setCloudVideoModel('ltx-2.5-i2v')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('ltx-2.5-i2v')
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.source_path).toBe('user-1/staged-source.png')
  })

  it('Animate: ein Referenzmodell bekommt das Bild als einzige Referenz', async () => {
    const s = useCreateStore.getState()
    s.setIntent('animate')
    s.setCloudVideoModel('minimax-h3-ref')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('minimax-h3-ref')
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.image_paths).toEqual(['user-1/staged-source.png'])
    expect(submitted[0].params.source_path).toBeUndefined()
  })

  it('Animate: eine alte Wahl aus dem Video-Waehler faellt auf ein Modell, das Bild zu Video kann', async () => {
    const s = useCreateStore.getState()
    s.setIntent('animate')
    s.setCloudVideoModel('ltx-2.5-t2v')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted[0].model).not.toBe('ltx-2.5-t2v')
    expect(submitted[0].model).toBe('minimax-h3')
  })

  it('Enhance Image laeuft als Bild-Upscale auf dem festen Endpunkt und laesst die Bildwahl stehen', async () => {
    const s = useCreateStore.getState()
    s.setCloudImageModel('flux-dev')
    s.setIntent('upscale')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].params.op).toBe('upscale')
    expect(submitted[0].params.target_resolution).toBe(useCreateStore.getState().targetResolution)
    expect(submitted[0].params.studio_options).toBeUndefined()
    expect(hoisted.studioQuote).not.toHaveBeenCalled()
    expect(useCreateStore.getState().gallery[0].model).toBe('flux-dev')
    expect(useCreateStore.getState().cloudImageModel).toBe('flux-dev')
  })

  it('ein Studio-Bildmodell im Bild-Tab rutscht nie in ein Cutout, einen Radierer oder Enhance', async () => {
    const s = useCreateStore.getState()
    s.setCloudImageModel('qwen-image-2.1')
    s.setIntent('removebg')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted[0].params.op).toBe('removebg')
    expect(submitted[0].model).not.toBe('qwen-image-2.1')
  })

  it('ein Modellwechsel und ein Wechsel der Unterkategorie werfen die Optionen weg', () => {
    const s = useCreateStore.getState()
    s.setIntent('image')
    s.setCloudImageModel('z-image')
    s.setCloudImageModel('qwen-image-2.1')
    s.setCloudStudioOptions({ resolution: '2k' })
    // Dieselbe Wahl noch einmal: die Optionen bleiben.
    s.setCloudImageModel('qwen-image-2.1')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({ resolution: '2k' })
    s.setCloudImageModel('z-image')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
    // Die Optionen gehoeren zum Modell, das die Unterkategorie faehrt: der
    // Videowaehler aendert an einem Bildlauf nichts.
    s.setCloudStudioOptions({ resolution: '2k' })
    s.setCloudVideoModel('wan-2.2-720p')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({ resolution: '2k' })
    s.setIntent('video')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
    s.setCloudStudioOptions({ resolution: '1080p' })
    s.setCloudVideoModel('ltx-2.5-t2v')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
    s.setCloudStudioOptions({ resolution: '1080p' })
    s.setIntent('animate')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
  })
})

describe('gegen den Server von heute', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: alterServer() }) })

  it('ein gespeichertes neues Modell, das der Server nicht kennt, startet als der Standard des Servers', async () => {
    const s = useCreateStore.getState()
    s.setIntent('video')
    s.setCloudVideoModel('ltx-2.5-t2v')
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].model).toBe('wan-2.2-720p')
    expect(submitted[0].params.op).toBe('generate')
  })

  it('Bearbeiten ohne Wahl startet auf dem ersten Editor des Servers, wie vor diesem Stand', async () => {
    const s = useCreateStore.getState()
    s.setIntent('edit')
    s.setCloudImageModel('')
    useCreateStore.setState({ source: BILD, mask: { filename: 'm.png', url: 'data:image/png;base64,AA', width: 512, height: 512 } as never })
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('flux-dev')
    expect(submitted[0].params.op).toBe('edit')
  })

  it('Enhance Image laeuft wie vorher, ohne Studio', async () => {
    const s = useCreateStore.getState()
    s.setIntent('upscale')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted[0].params.op).toBe('upscale')
  })
})
