/**
 * Discord 2026-09-26 (a user: "This render lives on the local engine, which
 * isn't reachable right now. Why do I keep getting that?"): a tile that
 * failed while ComfyUI was away stayed dark until the next app start. When
 * the engine answers again every such tile gets a fresh URL and loads again.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCreateStore, type GalleryItem } from '../createStore'
import { galleryItemUrl } from '../../components/create/experimental/galleryUrl'

const tile = (id: string, over: Partial<GalleryItem> = {}): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: '', negativePrompt: '', model: 'm', modelType: 'sdxl',
  seed: 1, steps: 1, cfgScale: 1, sampler: 'euler', scheduler: 'normal', width: 1, height: 1, batchSize: 1, createdAt: 1, ...over,
}) as GalleryItem

beforeEach(() => {
  useCreateStore.setState({
    comfyRunning: false,
    gallery: [
      tile('offline', { unavailable: true, unavailableReason: 'offline' }),
      tile('gone', { unavailable: true, unavailableReason: 'gone' }),
      tile('cloud', { unavailable: true, jobId: 'j' }),
      tile('fine'),
    ],
  })
})

describe('tiles come back with the engine', () => {
  it('only offline local tiles are retried, each with a new URL', () => {
    const before = galleryItemUrl(useCreateStore.getState().gallery[0])
    useCreateStore.getState().setComfyRunning(true)
    const [offline, gone, cloud, fine] = useCreateStore.getState().gallery
    expect(offline.unavailable).toBeUndefined()
    expect(offline.reloadKey).toBe(1)
    expect(galleryItemUrl(offline)).not.toBe(before)
    expect(galleryItemUrl(offline)).toContain('lu_retry=1')
    expect(gone.unavailable).toBe(true)
    expect(cloud.unavailable).toBe(true)
    expect(fine.reloadKey).toBeUndefined()
  })

  it('staying up does not retry again', () => {
    useCreateStore.getState().setComfyRunning(true)
    const once = useCreateStore.getState().gallery
    useCreateStore.getState().setComfyRunning(true)
    expect(useCreateStore.getState().gallery).toBe(once)
  })
})
