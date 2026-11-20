/**
 * Studio-Felder von createStore (Portplan Abschnitt 3e/3f, Paket P5).
 *
 * Vier Faelle, die der Inhaber/der Plan als Waechter verlangen:
 *  1. Ein Zustand der Version 1 (vor dem Studio) liest cloudStudioOptions als
 *     {} ein, nie als undefined, sonst faellt Object.entries() im Composer.
 *  2. Ein LOKALER Lauf laesst den Cloud-Modellwaehler in Ruhe: im Desktop
 *     landen in derselben Galerie auch ComfyUI-/MLX-Ergebnisse, anders als im
 *     Web, das keine lokale Spur kennt.
 *  3. setCloudOpModel wirft die Studio-Optionen weg (ein liegen gebliebener
 *     Wert waere beim naechsten Endpunkt vielleicht nicht erlaubt).
 *  4. mergeGallery ueberschreibt nie einen vorhandenen Prompt/Label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Gleiches Muster wie createStore.test.ts / createStore-migrate.test.ts:
// zustand/persist braucht window.localStorage schon beim Laden des Moduls.
vi.hoisted(() => {
  const map = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = ls
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  g.window = Object.assign(g.window ?? {}, { localStorage: ls })
})

vi.mock('../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))
vi.mock('../../api/comfyui', () => ({
  classifyModel: vi.fn(() => 'unknown'),
}))

import { useCreateStore } from '../createStore'
import type { GalleryItem } from '../createStore'

const makeGalleryItem = (id: string, patch: Partial<GalleryItem> = {}): GalleryItem => ({
  id,
  type: 'image',
  filename: `${id}.png`,
  subfolder: '',
  prompt: 'test',
  negativePrompt: '',
  model: 'flux-schnell',
  modelType: 'unknown',
  seed: 42,
  steps: 20,
  cfgScale: 7,
  sampler: 'euler',
  scheduler: 'normal',
  width: 1024,
  height: 1024,
  batchSize: 1,
  createdAt: Date.now(),
  ...patch,
})

describe('createStore Studio fields', () => {
  beforeEach(() => {
    localStorage.clear()
    useCreateStore.setState({
      gallery: [],
      backend: 'local',
      cloudImageModel: '',
      cloudVideoModel: '',
      cloudOpModel: '',
      cloudStudioOptions: {},
      cloudStudioCredits: null,
    })
  })

  // ── 1. Persistenzfall: Version 1 -> Version 2 ──────────────────

  describe('a version-1 blob rehydrates cloudStudioOptions as {}', () => {
    const KEY = 'create-store'

    async function freshStoreFrom(state: Record<string, unknown>, version?: number) {
      localStorage.setItem(KEY, JSON.stringify(version === undefined ? { state } : { state, version }))
      vi.resetModules()
      const mod = await import('../createStore')
      return mod.useCreateStore
    }

    it('a pre-Studio (version 1) blob without the field reads {} and null, never undefined', async () => {
      const store = await freshStoreFrom({ mode: 'image', steps: 33 }, 1)
      const s = store.getState()
      expect(s.cloudStudioOptions).toEqual({})
      expect(s.cloudStudioCredits).toBeNull()
      // The Composer calls Object.entries() on this straight away, must
      // never throw on an old blob.
      expect(() => Object.entries(s.cloudStudioOptions)).not.toThrow()
      expect(Object.entries(s.cloudStudioOptions)).toEqual([])
    })

    it('a version-1 blob that already carries an explicit undefined is caught too', async () => {
      const store = await freshStoreFrom(
        { mode: 'image', cloudStudioOptions: undefined, cloudStudioCredits: undefined },
        1,
      )
      const s = store.getState()
      expect(s.cloudStudioOptions).toEqual({})
      expect(s.cloudStudioCredits).toBeNull()
    })

    it('a version-2 blob keeps its own saved options across a reload', async () => {
      const store = await freshStoreFrom(
        { mode: 'image', cloudStudioOptions: { duration: 8 } },
        2,
      )
      expect(store.getState().cloudStudioOptions).toEqual({ duration: 8 })
    })

    it('a saved price never rehydrates, at any version: a price from yesterday is a lie', async () => {
      const store = await freshStoreFrom(
        { mode: 'image', cloudStudioCredits: 4200 },
        2,
      )
      expect(store.getState().cloudStudioCredits).toBeNull()
    })

    it('writes version 2 into storage after the first change', async () => {
      const store = await freshStoreFrom({ mode: 'image' }, 1)
      store.getState().setSteps(11)
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
      expect(raw.version).toBe(2)
    })
  })

  // ── 2. addToGallery: nur die Wolken-Spur stellt den Waehler um ─

  describe('addToGallery only steers the cloud model picker on the cloud backend', () => {
    it('a local render leaves cloudImageModel untouched', () => {
      useCreateStore.setState({ backend: 'local', cloudImageModel: 'stays-as-is' })
      useCreateStore.getState().addToGallery(makeGalleryItem('local-1', { model: 'flux-schnell' }))
      expect(useCreateStore.getState().cloudImageModel).toBe('stays-as-is')
    })

    it('a local video render leaves cloudVideoModel untouched too', () => {
      useCreateStore.setState({ backend: 'local', cloudVideoModel: 'stays-as-is' })
      useCreateStore.getState().addToGallery(makeGalleryItem('local-2', { type: 'video', model: 'wan-2.2-720p' }))
      expect(useCreateStore.getState().cloudVideoModel).toBe('stays-as-is')
    })

    it('a cloud image render DOES steer cloudImageModel to the model that made it', () => {
      useCreateStore.setState({ backend: 'cloud', cloudImageModel: 'flux-dev' })
      useCreateStore.getState().addToGallery(makeGalleryItem('cloud-1', { model: 'flux-schnell' }))
      expect(useCreateStore.getState().cloudImageModel).toBe('flux-schnell')
    })

    it('a cloud video render steers cloudVideoModel the same way', () => {
      useCreateStore.setState({ backend: 'cloud', cloudVideoModel: 'wan-2.2-fast' })
      useCreateStore.getState().addToGallery(makeGalleryItem('cloud-2', { type: 'video', model: 'wan-2.2-720p' }))
      expect(useCreateStore.getState().cloudVideoModel).toBe('wan-2.2-720p')
    })

    it('the gallery item still lands regardless of backend', () => {
      useCreateStore.setState({ backend: 'local' })
      useCreateStore.getState().addToGallery(makeGalleryItem('local-3'))
      expect(useCreateStore.getState().gallery).toHaveLength(1)
      expect(useCreateStore.getState().gallery[0].id).toBe('local-3')
    })
  })

  // ── 3. setCloudOpModel wirft die Studio-Optionen weg ────────────

  describe('setCloudOpModel', () => {
    it('clears cloudStudioOptions when the pick moves the run onto another model', () => {
      useCreateStore.getState().setIntent('lipsync')
      useCreateStore.getState().setCloudOpModel('latentsync')
      useCreateStore.setState({ cloudStudioOptions: { duration: 5, voice: 'x' } })
      useCreateStore.getState().setCloudOpModel('lipsync-2')
      expect(useCreateStore.getState().cloudOpModel).toBe('lipsync-2')
      expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
    })

    it('keeps them when the same model is picked again', () => {
      useCreateStore.getState().setIntent('lipsync')
      useCreateStore.getState().setCloudOpModel('latentsync')
      useCreateStore.setState({ cloudStudioOptions: { duration: 5 } })
      useCreateStore.getState().setCloudOpModel('latentsync')
      expect(useCreateStore.getState().cloudStudioOptions).toEqual({ duration: 5 })
    })

    it('does not touch cloudStudioCredits (a stale price is cleared by a fresh quote, not by a model switch)', () => {
      useCreateStore.setState({ cloudStudioCredits: 900 })
      useCreateStore.getState().setCloudOpModel('infinitetalk-fast')
      expect(useCreateStore.getState().cloudStudioCredits).toBe(900)
    })
  })

  // ── 4. mergeGallery ueberschreibt nie ────────────────────────────

  describe('mergeGallery', () => {
    it('backfills a missing prompt/label on an existing item, never overwriting one that is already there', () => {
      useCreateStore.setState({
        gallery: [makeGalleryItem('j1', { jobId: 'j1', prompt: '', label: undefined, createdAt: 1000 })],
      })
      useCreateStore.getState().mergeGallery([
        makeGalleryItem('j1', { jobId: 'j1', prompt: 'a red fox', label: 'Horror Creature', createdAt: 1000 }),
      ])
      const item = useCreateStore.getState().gallery.find((g) => g.jobId === 'j1')
      expect(item?.prompt).toBe('a red fox')
      expect(item?.label).toBe('Horror Creature')
    })

    it('never overwrites a prompt/label the customer already saw', () => {
      useCreateStore.setState({
        gallery: [makeGalleryItem('j2', { jobId: 'j2', prompt: 'old prompt', label: 'Old Label', createdAt: 2000 })],
      })
      useCreateStore.getState().mergeGallery([
        makeGalleryItem('j2', { jobId: 'j2', prompt: 'new prompt', label: 'New Label', createdAt: 2000 }),
      ])
      const item = useCreateStore.getState().gallery.find((g) => g.jobId === 'j2')
      expect(item?.prompt).toBe('old prompt')
      expect(item?.label).toBe('Old Label')
    })

    it('adds an unknown job with the servers metadata', () => {
      useCreateStore.setState({ gallery: [] })
      useCreateStore.getState().mergeGallery([
        makeGalleryItem('j3', { jobId: 'j3', prompt: 'fresh from another device', createdAt: 3000 }),
      ])
      expect(useCreateStore.getState().gallery).toHaveLength(1)
      expect(useCreateStore.getState().gallery[0].prompt).toBe('fresh from another device')
    })

    it('refreshes remoteUrl on an existing item without touching its other fields', () => {
      useCreateStore.setState({
        gallery: [makeGalleryItem('j4', { jobId: 'j4', remoteUrl: 'https://old.example/x', createdAt: 4000 })],
      })
      useCreateStore.getState().mergeGallery([
        makeGalleryItem('j4', { jobId: 'j4', remoteUrl: 'https://fresh.example/x', createdAt: 4000 }),
      ])
      const item = useCreateStore.getState().gallery.find((g) => g.jobId === 'j4')
      expect(item?.remoteUrl).toBe('https://fresh.example/x')
    })
  })
})
