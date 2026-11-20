/**
 * A picture made in the running session can be picked as the source in Edit.
 *
 * Found by hand on 10.10.2026 on a Mac: "Could not load that gallery image:
 * Load failed" for every picture made since the app started, while pictures
 * from the days before worked. A local render sits in the gallery as a
 * `data:` URL until the next start; after that it is a `blob:` URL read back
 * from disk. The app's content policy lets the page fetch `blob:` and not
 * `data:`, so the fresh ones failed and the old ones did not.
 *
 * The stand-in for the policy is a `fetch` that refuses every `data:` URL the
 * way the webview does. The browser preview has no such policy, which is why
 * no end to end test saw this.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/a-fresh-local-render-goes-into-edit.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

vi.mock('../../../../api/comfyui', () => ({
  getImageUrl: vi.fn((filename: string) => `http://127.0.0.1:8188/view?filename=${filename}`),
  checkComfyConnection: vi.fn(async () => false),
}))
vi.mock('../../../../api/cloud/jobs', () => ({
  refreshResultUrl: vi.fn(async () => null),
  resolveResultUrl: vi.fn(async () => ({ kind: 'unknown' })),
}))
vi.mock('../../../../api/backend', () => ({
  backendCall: vi.fn(),
  fetchLocalhostBytes: vi.fn(),
  isTauri: () => true,
}))

import { fetchGalleryItemBlob } from '../galleryUrl'
import { blobFromUrl } from '../../../../lib/render/data-url'
import type { GalleryItem } from '../../../../stores/createStore'

// The eight bytes every PNG starts with.
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_HEAD).toString('base64')}`

const fetchMock = vi.fn(async (url: string) => {
  // What the webview does to a fetch its policy does not allow.
  if (String(url).startsWith('data:')) throw new TypeError('Load failed')
  return new Response(new Blob([new Uint8Array(PNG_HEAD)], { type: 'image/png' }))
})

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const freshRender = {
  id: 'fresh-1',
  type: 'image',
  filename: 'mlx-1791660879566-5024.png',
  dataUrl: PNG_DATA_URL,
  localPath: '/data/images/mlx-1791660879566-5024.png',
} as unknown as GalleryItem

describe('a render of the running session', () => {
  it('comes back as its bytes without a request the policy would refuse', async () => {
    const blob = await fetchGalleryItemBlob(freshRender)
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(PNG_HEAD)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a render read back from disk after a restart is still fetched', async () => {
    const blob = await fetchGalleryItemBlob({ ...freshRender, dataUrl: 'blob:tauri://localhost/abc' } as GalleryItem)
    expect(blob.type).toBe('image/png')
    expect(fetchMock).toHaveBeenCalledWith('blob:tauri://localhost/abc')
  })

  it('a request that answers with an error still says so', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(blobFromUrl('http://127.0.0.1:8188/view?filename=gone.png')).rejects.toThrow('media request failed (404)')
  })
})

describe('no door in Create fetches a URL that can be a data: URL', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../../../..', path), 'utf8')

  it('the source loader and the local edit hand the bytes over without fetch', () => {
    expect(read('components/create/experimental/loadImage.ts')).not.toMatch(/fetch\(/)
    expect(read('hooks/useCreate.ts')).not.toMatch(/fetch\(ref\.url\)/)
    expect(read('components/create/experimental/galleryUrl.ts')).toContain('const tryFetch = blobFromUrl')
  })
})
