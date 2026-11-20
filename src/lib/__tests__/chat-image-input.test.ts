import { describe, expect, it, vi } from 'vitest'
import { imageDimensions, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_PIXELS, prepareChatImage, prepareChatImages } from '../chat-image-input'

function png(width: number, height: number) {
  const data = new Uint8Array(24)
  data.set([137,80,78,71,13,10,26,10], 0)
  data.set([73,72,68,82], 12)
  const view = new DataView(data.buffer)
  view.setUint32(16, width); view.setUint32(20, height)
  return new Blob([data], { type: 'image/png' })
}

describe('chat image admission', () => {
  it('reads PNG dimensions without decoding pixels', async () => {
    expect(await imageDimensions(png(4000, 3000))).toEqual({ width: 4000, height: 3000 })
  })
  it('rejects a compressed pixel bomb before invoking the decoder', async () => {
    await expect(imageDimensions(png(50000, 50000))).rejects.toThrow('32 megapixels')
    await expect(imageDimensions(png(1, MAX_IMAGE_PIXELS))).rejects.toThrow('32 megapixels')
  })
  it('rejects unrecognized and truncated files with an actionable error', async () => {
    for (const blob of [new Blob([]), new Blob(['<svg/>']), new Blob([new Uint8Array([255,216,255,192,0,8])])]) {
      await expect(imageDimensions(blob)).rejects.toThrow('valid PNG')
    }
  })
  it('accepts baseline and progressive JPEG headers', async () => {
    for (const marker of [0xc0, 0xc2]) {
      const bytes = new Uint8Array([255,216,255,marker,0,8,8,4,0,8,0,1])
      expect(await imageDimensions(new Blob([bytes]))).toEqual({ width: 2048, height: 1024 })
    }
  })
  it('reads GIF and extended WebP dimensions', async () => {
    const gif = new Uint8Array([71,73,70,56,57,97,0,4,0,2])
    expect(await imageDimensions(new Blob([gif]))).toEqual({ width: 1024, height: 512 })
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'),0)
    webp.set(new TextEncoder().encode('WEBPVP8X'),8)
    webp.set([255,3,0,255,1,0],24)
    expect(await imageDimensions(new Blob([webp]))).toEqual({ width: 1024, height: 512 })
  })
  it('rejects oversized files before reading even their header', async () => {
    const read = vi.fn()
    await expect(prepareChatImage({ size: MAX_IMAGE_FILE_BYTES + 1, slice: read } as unknown as File)).rejects.toThrow('20 MB')
    expect(read).not.toHaveBeenCalled()
  })
  it('finds the frame header of a phone JPEG behind large EXIF, ICC and XMP segments', async () => {
    // Five 64 KiB application segments before the SOF, 320 KiB in: past the
    // old 256 KiB window, which refused such photos as "not a valid JPEG".
    const segments = 5, segment = 65535
    const bytes = new Uint8Array(2 + segments * (2 + segment) + 12)
    bytes.set([255, 216], 0)
    let at = 2
    for (let i = 0; i < segments; i++) {
      bytes.set([255, 0xe1 + i, segment >> 8, segment & 255], at)
      at += 2 + segment
    }
    bytes.set([255, 0xc0, 0, 8, 8, 4, 0, 8, 0, 1], at)
    expect(await imageDimensions(new Blob([bytes]))).toEqual({ width: 2048, height: 1024 })
  })
  it('a saved legacy image in a format the header scan does not know is decoded, not refused', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 50, close })))
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }),
      toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(['x'], { type })) }
    vi.stubGlobal('document', { createElement: () => canvas })
    vi.stubGlobal('FileReader', class { result = ''; onload?: () => void
      readAsDataURL() { this.result = 'data:image/png;base64,eA=='; this.onload?.() } })
    const bmp = new File([new Uint8Array([66, 77, 0, 0, 0, 0])], 'old.bmp', { type: 'image/bmp' })
    await expect(prepareChatImage(bmp)).rejects.toThrow('valid PNG')
    expect(await prepareChatImage(bmp, { legacy: true })).toEqual({ data: 'eA==', mimeType: 'image/png', name: 'old.bmp' })
    expect(close).toHaveBeenCalled()
    // A KNOWN header above the pixel cap stays refused, legacy or not.
    await expect(prepareChatImage(new File([png(50000, 50000)], 'bomb.png', { type: 'image/png' }), { legacy: true })).rejects.toThrow('32 megapixels')
    vi.unstubAllGlobals()
  })
})

describe('serial image selection', () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ name: `${i}.png` }) as File)
  it('reads only the available slots, one file at a time', async () => {
    let active = 0, peak = 0
    const prepare = vi.fn(async (file: File) => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return { data: 'a', name: file.name, mimeType: 'image/png' }
    })
    const result = await prepareChatImages(files, 2, undefined, prepare)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
    expect(result.images.map(i => i.name)).toEqual(['0.png', '1.png'])
    await prepareChatImages(files, 0, undefined, prepare)
    expect(prepare).toHaveBeenCalledTimes(2)
  })
  it('a broken file does not discard the valid attachments or reject the batch', async () => {
    const result = await prepareChatImages(files, 2, undefined, async file => {
      if (file.name === '0.png') throw new Error('bad header')
      return { data: 'a', name: file.name, mimeType: 'image/png' }
    })
    expect(result.images).toHaveLength(1)
    expect(result.errors).toEqual(['0.png: bad header'])
  })
  it('switching chats while decoding discards that result and stops the next decode', async () => {
    let cancelled = false
    const prepare = vi.fn(async (file: File) => {
      cancelled = true
      return { data: 'a', name: file.name, mimeType: 'image/png' }
    })
    const result = await prepareChatImages(files, 5, () => cancelled, prepare)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(result.images).toHaveLength(0)
  })
})
