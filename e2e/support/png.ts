import { crc32, deflateSync } from 'node:zlib'

/**
 * A real PNG of the given size: a colour gradient, so a screenshot shows
 * where the picture is and how large. The specs otherwise hand in one pixel,
 * which says nothing about a layout.
 */
export function gradientPng(width: number, height: number): Buffer {
  const row = 1 + width * 3
  const raw = Buffer.alloc(row * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3
      raw[at] = Math.round((x / width) * 255)
      raw[at + 1] = Math.round((y / height) * 200)
      raw[at + 2] = 160
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([head, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
