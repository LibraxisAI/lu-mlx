import type { ImageAttachment } from '../types/chat'

export const MAX_CHAT_IMAGES = 5
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 32 * 1024 * 1024
export const MAX_IMAGE_EDGE = 2048
export const MAX_IMAGE_BYTES = 512 * 1024

/** How far into the file the header scan reads. Phone JPEGs carry EXIF, XMP,
 * ICC and MPF segments of up to 64 KiB each before the frame header, so a
 * short window rejected valid photos. One MiB is still a cheap slice. */
const HEADER_WINDOW = 1024 * 1024

/** Read dimensions before decoding: a tiny compressed file may contain an
 * enormous bitmap. Unsupported/ambiguous headers never reach the decoder. */
export async function imageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  const bytes = new Uint8Array(await file.slice(0, HEADER_WINDOW).arrayBuffer())
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0))
  let width = 0, height = 0
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 'PNG\r\n\x1a\n') && ascii(12, 'IHDR')) {
    width = view.getUint32(16); height = view.getUint32(20)
  } else if (bytes.length >= 10 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) {
    width = view.getUint16(6, true); height = view.getUint16(8, true)
  } else if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    } else if (ascii(12, 'VP8 ') && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff
    } else if (ascii(12, 'VP8L') && bytes[20] === 0x2f) {
      width = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8))
      height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0xf) << 10))
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2
    while (p + 3 < bytes.length) {
      if (bytes[p++] !== 0xff) break
      while (bytes[p] === 0xff) p++
      const marker = bytes[p++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (p + 2 > bytes.length) break
      const size = view.getUint16(p)
      if (size < 2 || p + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
        height = view.getUint16(p + 3); width = view.getUint16(p + 5)
        break
      }
      p += size
    }
  }
  if (!width || !height) throw new Error('Use a valid PNG, JPEG, WebP or GIF image.')
  if (width * height > MAX_IMAGE_PIXELS || width > 32768 || height > 32768) {
    throw new Error('This image is too large. Resize it to 32 megapixels or less and try again.')
  }
  return { width, height }
}

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('This image could not be read. Try selecting it again.'))
    reader.onabort = () => reject(new Error('Image loading was cancelled.'))
    reader.readAsDataURL(blob)
  })
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new Error('This image could not be prepared. Try another image.'))
  }, type, quality))
}

export interface PrepareOptions {
  /** Longest edge of the result. Previews ask for less than the model does. */
  maxEdge?: number
  /**
   * An image that is already in a saved chat. Builds before the attachment
   * store accepted any `image/*` at any size, and the model and the viewer
   * both took it. A header this scanner cannot read (BMP, AVIF, HEIC) is
   * therefore no reason to refuse it any more; a KNOWN header above the pixel
   * cap still is, because decoding it is the memory spike this module exists
   * to prevent.
   */
  legacy?: boolean
}

export async function prepareChatImage(file: File, options: PrepareOptions = {}): Promise<ImageAttachment> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error('This image exceeds 20 MB. Choose a smaller file.')
  try {
    await imageDimensions(file)
  } catch (error) {
    const unknownFormat = error instanceof Error && error.message.startsWith('Use a valid')
    if (!options.legacy || !unknownFormat) throw error
  }
  // A single frame also bounds animated GIF/WebP decoding in the transcript.
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be opened. Try a PNG or JPEG copy.')
  })
  const canvas = document.createElement('canvas')
  try {
    // ImageBitmap applies EXIF orientation; use its dimensions, not the raw
    // JPEG header, or portrait phone photos would be stretched after rotation.
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) throw new Error('This image is too large. Resize it to 32 megapixels or less and try again.')
    const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Image preparation is unavailable. Restart the app and try again.')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // Keep transparency and sharp screenshot text whenever PNG fits the budget.
    let blob = await encode(canvas, 'image/png')
    if (blob.size > MAX_IMAGE_BYTES) {
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'source-over'
      for (const quality of [0.85, 0.7, 0.5]) {
        blob = await encode(canvas, 'image/jpeg', quality)
        if (blob.size <= MAX_IMAGE_BYTES) break
      }
    }
    while (blob.size > MAX_IMAGE_BYTES && Math.max(canvas.width, canvas.height) > 512) {
      canvas.width = Math.max(1, Math.round(canvas.width * 0.75))
      canvas.height = Math.max(1, Math.round(canvas.height * 0.75))
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      blob = await encode(canvas, 'image/jpeg', 0.8)
    }
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('This image is too detailed. Crop it or choose a smaller image.')
    return { data: await dataURL(blob), mimeType: blob.type, name: file.name }
  } finally {
    bitmap.close()
    canvas.width = 0; canvas.height = 0
  }
}

/** Serial decoding, limit BEFORE reading. Cancellation stops the next decode
 * and prevents results from crossing into another conversation. */
export async function prepareChatImages(
  files: readonly File[], slots: number, cancelled: () => boolean = () => false,
  prepare: (file: File) => Promise<ImageAttachment> = prepareChatImage,
): Promise<{ images: ImageAttachment[]; errors: string[] }> {
  const images: ImageAttachment[] = []
  const errors: string[] = []
  for (const file of files.slice(0, Math.max(0, Math.min(MAX_CHAT_IMAGES, slots)))) {
    if (cancelled()) break
    try {
      const image = await prepare(file)
      if (cancelled()) break
      images.push(image)
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : 'This image could not be opened.'}`)
    }
  }
  return { images, errors }
}
