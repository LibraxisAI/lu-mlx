// @vitest-environment jsdom
/**
 * Fund F9 (05.10.2026) im Desktop: die Cloud speichert nur PNG, JPEG und WebP.
 * Das Web nimmt deshalb nichts anderes mehr an. Der Desktop darf weiter jedes
 * Bild nehmen, das die WebView lesen kann (HEIC vom iPhone auf dem Mac, AVIF,
 * GIF, BMP), weil loadImageRef es vor dem Hochladen als PNG neu schreibt und die
 * Cloud aus genau dieser Vorschau hochlaedt. Dieser Test haelt den Grund fest:
 * faellt die Umwandlung weg, muessen die Auswahlfelder der Cloud auf die drei
 * Formate eingeschraenkt werden wie im Web.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const comfy = vi.hoisted(() => ({ uploadImage: vi.fn(async () => 'input.png') }))
vi.mock('../../../../api/comfyui', () => ({ uploadImage: comfy.uploadImage, classifyModel: () => 'sdxl' }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))

import { loadImageRef } from '../loadImage'
import { useCreateStore } from '../../../../stores/createStore'

const PNG_URL = 'data:image/png;base64,iVBORw0KGgo='
let decodable = true

beforeEach(() => {
  decodable = true
  comfy.uploadImage.mockClear()
  useCreateStore.setState({ backend: 'cloud' })
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 640
    naturalHeight = 480
    set src(_url: string) { queueMicrotask(() => (decodable ? this.onload?.() : this.onerror?.())) }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG_URL)
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['png'], { type: 'image/png' }) })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('loadImageRef vor dem Hochladen in die Cloud', () => {
  it.each([['photo.heic', 'image/heic'], ['a.avif', 'image/avif'], ['b.gif', 'image/gif'], ['c.bmp', 'image/bmp']])(
    '%s wird als PNG neu geschrieben, die Cloud laedt nie das Original hoch',
    async (name, type) => {
      const ref = await loadImageRef(new File(['raw'], name, { type }))
      expect(ref.url).toBe(PNG_URL)
      expect(ref).toMatchObject({ filename: '', width: 640, height: 480 })
      expect(comfy.uploadImage).not.toHaveBeenCalled()
    },
  )

  it.each([['a.png', 'image/png'], ['b.jpg', 'image/jpeg'], ['c.webp', 'image/webp']])(
    '%s bleibt, wie es ist',
    async (name, type) => {
      const ref = await loadImageRef(new File(['raw'], name, { type }))
      expect(ref.url.startsWith(`data:${type}`)).toBe(true)
      expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled()
    },
  )

  it('ein Bild, das die WebView nicht lesen kann, scheitert vor dem Start mit einem englischen Satz', async () => {
    decodable = false
    await expect(loadImageRef(new File(['raw'], 'photo.heic', { type: 'image/heic' })))
      .rejects.toThrow('the image could not be decoded, use PNG, JPG or WebP')
  })

  it('lokal geht dieselbe PNG-Fassung an ComfyUI', async () => {
    useCreateStore.setState({ backend: 'local' })
    const ref = await loadImageRef(new File(['raw'], 'photo.heic', { type: 'image/heic' }))
    expect(ref.filename).toBe('input.png')
    const sent = comfy.uploadImage.mock.calls[0] as unknown as [File]
    expect(sent[0].type).toBe('image/png')
    expect(sent[0].name).toBe('photo.png')
  })
})
