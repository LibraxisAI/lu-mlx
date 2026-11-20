/**
 * One way of counting for what a Mac setup downloads (persona walk of the
 * Mac app, 09.10.2026, Fund 21).
 *
 * Settings, the Model Manager and Create said "about 5.5 GB" and "about
 * 19 GB", the tiles of the same starter models said "2.4 GB" and "16.8 GB".
 *
 * Run: npx vitest run src/lib/__tests__/mac-setup-sizes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatBytes, siGbToBytes } from '../formatters'
import {
  MAC_IMAGE_ENGINE_SI_GB, MAC_IMAGE_STARTER_SI_GB, MAC_VIDEO_ENGINE_SI_GB, MAC_VIDEO_LTX_ENGINE_SI_GB,
  MAC_IMAGE_SETUP_SIZE, MAC_VIDEO_ENGINE_SIZE, aboutGb, macVideoSetupSiGb, macVideoSetupCopy,
} from '../mac-setup-sizes'

const root = resolve(__dirname, '../../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf-8')

/** `size_gb` of one catalogue entry, as Rust writes it. */
function catalogueSize(file: string, id: string): number {
  const source = read(`src-tauri/src/commands/${file}`)
  const at = source.indexOf(`id: "${id}",`)
  expect(at, `${id} in ${file}`).toBeGreaterThan(-1)
  const m = source.slice(at, at + 600).match(/size_gb: ([\d.]+)/)
  expect(m, `size_gb of ${id}`).not.toBeNull()
  return Number(m![1])
}

/** The number a tile writes for a catalogue size. */
const tileGb = (siGb: number) => Number((siGbToBytes(siGb) / 1024 ** 3).toFixed(1))

describe('the starter sizes', () => {
  it('are the ones the catalogue has', () => {
    expect(MAC_IMAGE_STARTER_SI_GB).toBe(catalogueSize('mlx.rs', 'sd-turbo'))
  })

  it('the image engine is the size its own progress line quotes', () => {
    expect(read('src/api/mlx-install.ts')).toContain(`Setting up the image engine (about ${MAC_IMAGE_ENGINE_SI_GB} GB, one time)`)
  })
})

describe('the setup sentences', () => {
  it('say what the tiles add up to', () => {
    expect(formatBytes(siGbToBytes(MAC_IMAGE_STARTER_SI_GB))).toBe('2.4 GB')
    expect(MAC_IMAGE_SETUP_SIZE).toBe('about 5 GB')
    expect(MAC_VIDEO_ENGINE_SIZE).toBe('about 1 GB')
    // Tile and sentence never lie more than half a GB apart.
    const number = (s: string) => Number(s.replace(/\D/g, ''))
    expect(Math.abs(number(MAC_IMAGE_SETUP_SIZE) - (tileGb(MAC_IMAGE_ENGINE_SI_GB) + tileGb(MAC_IMAGE_STARTER_SI_GB)))).toBeLessThanOrEqual(0.5)
  })

  it('a size is never "about 0 GB"', () => {
    expect(aboutGb(0.2)).toBe('about 1 GB')
  })

  it('are written in one place: no surface carries its own figure', () => {
    for (const file of [
      'src/components/settings/MlxMediaSettings.tsx',
      'src/components/models/MacMediaLane.tsx',
      'src/components/create/experimental/Stage.tsx',
    ]) {
      const source = read(file)
      expect(source, file).not.toMatch(/about 5\.5 GB|about 19 GB in all/)
      expect(source, file).toContain('mac-setup-sizes')
    }
  })
})

/**
 * The video starter is chosen per Mac since the real run of 09.10.2026, so
 * its card is written from the catalogue entry. LTX-2.3 Distilled 4-bit is
 * 20.5 GB in the catalogue, and its text encoder (8.1 GB) lies in a
 * repository of its own: the card says the sum that is fetched.
 */
describe('the video card of Create', () => {
  const plain = { title: 'Local video generation needs a one-time setup', description: 'plain' }
  const ltx = { name: 'LTX-2.3 Distilled 4-bit', family: 'ltx_2q', sizeGB: catalogueSize('video.rs', 'ltx-2.3-q4'), textEncoderGB: 8.1 }
  const wan = { name: 'Wan 2.1 T2V 1.3B', family: 'wan_2', sizeGB: catalogueSize('video.rs', 'wan21-t2v-1.3b'), textEncoderGB: 0 }

  it('the figures are the catalogue\'s: 20.5 GB, and 8.1 GB for the text encoder', () => {
    expect(ltx.sizeGB).toBe(20.5)
    const source = read('src-tauri/src/commands/video.rs')
    const entry = source.slice(source.indexOf('id: "ltx-2.3-q4",'), source.indexOf('id: "ltx-2.3-q4",') + 600)
    expect(entry).toContain('text_encoder_repo: LTX23_TEXT_ENCODER,')
    expect(entry).toContain('starter: true,')
    expect(source).toMatch(/fn text_encoder_gb[\s\S]{0,160}else \{\s+8\.1\s+\}/)
  })

  it('counts the model, its text encoder and the engine that is still missing', () => {
    const q4 = { ...ltx, bringsItsEngine: true }
    expect(macVideoSetupSiGb(q4, true)).toBeCloseTo(20.5 + 8.1 + MAC_VIDEO_LTX_ENGINE_SI_GB)
    expect(macVideoSetupSiGb(q4, false)).toBeCloseTo(28.6)
    // An encoder that is on disk already is not counted again.
    expect(macVideoSetupSiGb({ ...q4, textEncoderGB: 0 }, false)).toBeCloseTo(20.5)
    expect(macVideoSetupSiGb({ ...wan, bringsItsEngine: false }, true)).toBeCloseTo(18 + MAC_VIDEO_ENGINE_SI_GB)
  })

  it('names the model and the sum, the way the tiles count', () => {
    const fresh = macVideoSetupCopy(plain, { choice: { pick: ltx }, memoryGb: 48, engineMissing: true })
    expect(fresh.canInstall).toBe(true)
    expect(fresh.title).toBe(plain.title)
    expect(fresh.description).toContain('downloads LTX-2.3 Distilled 4-bit with its text encoder, about 27 GB in all.')
    // Tile of the model (19.1 GB) and of the encoder (7.5 GB) and the engine.
    expect(tileGb(20.5) + tileGb(8.1) + tileGb(MAC_VIDEO_LTX_ENGINE_SI_GB)).toBeCloseTo(27.1, 1)
    expect(fresh.description).not.toMatch(/smallest|Wan/)

    const other = macVideoSetupCopy(plain, { choice: { pick: wan }, memoryGb: 48, engineMissing: true })
    expect(other.description).toContain('downloads Wan 2.1 T2V 1.3B, about 18 GB in all.')
  })

  it('says so and offers nothing where no starter runs', () => {
    const none = macVideoSetupCopy(plain, { choice: { pick: null, reason: 'memory', needGb: 16 }, memoryGb: 8, engineMissing: false })
    expect(none.canInstall).toBe(false)
    expect(none.title).toBe('Local video needs more memory than this Mac has')
    expect(none.description).toBe('The smallest video model to start with needs a Mac with 16 GB of memory, and this one has 8 GB. Nothing is downloaded, because it would not run here. Use LU Cloud for video on this Mac.')
  })

  it('keeps its plain text until the plan is read', () => {
    expect(macVideoSetupCopy(plain, null)).toEqual({ ...plain, canInstall: true })
    expect(macVideoSetupCopy(plain, { choice: { pick: null, reason: 'installed' }, memoryGb: 16, engineMissing: false })).toEqual({ ...plain, canInstall: true })
  })
})
