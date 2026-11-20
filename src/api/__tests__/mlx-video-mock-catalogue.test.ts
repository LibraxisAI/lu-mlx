/**
 * The video catalogue the browser tests run against says what Rust says.
 *
 * Since the real run of 09.10.2026 `video_list_models` names per entry the
 * rate a clip plays at, the size it is made at, whether a negative prompt is
 * read and that no slider sets steps or guidance. Create takes all four from
 * there and assumes none, so a mock that leaves one out, or still carries a
 * value from before, tests an interface no customer has.
 *
 * Since the same day it also names the memory a model is recommended for,
 * the text encoder a Get fetches beside the model and the starter of
 * Create's setup, and the texts say what was measured. The order is the
 * catalogue's, which is the order of the tiles.
 *
 * Run: npx vitest run src/api/__tests__/mlx-video-mock-catalogue.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf-8')

type Row = {
  id: string; family: string; defaultFrames: number; fps: number; defaultWidth: number; defaultHeight: number
  negativePrompt: boolean; userSampling: boolean
  sizeGB: number; minRamGB: number; recommendedRamGB: number; textEncoderGB: number; starter: boolean; description: string
}

/** `CATALOG` in video.rs, with the rules of `video_list_models` applied:
 *  `frame_rate`, `takes_negative_prompt`, `recommended_ram_gb` and, for a Mac
 *  with no text encoder on disk, `text_encoder_gb`. */
function rustCatalogue(): Row[] {
  const source = read('src-tauri/src/commands/video.rs')
  const start = source.indexOf('const CATALOG: &[CatalogEntry] = &[')
  const list = source.slice(start, source.indexOf('\n];', start))
  // The fields an entry leaves alone come from `ENTRY`.
  const base = source.slice(source.indexOf('const ENTRY: CatalogEntry = CatalogEntry {'))
  const field = (block: string, name: string) => block.match(new RegExp(`^\\s+${name}: (.+?),$`, 'm'))?.[1]
  const own = (block: string, name: string) => field(block, name) ?? field(base, name) ?? ''
  return list.split('CatalogEntry {').slice(1).map((block) => {
    const text = (name: string) => own(block, name).replace(/"/g, '')
    const family = own(block, 'family').includes('FAMILY') ? 'ltx_2q' : text('family')
    const minRam = Number(own(block, 'min_ram_gb'))
    // `""` in ENTRY, the name of a constant where an entry has its own.
    const encoder = text('text_encoder_repo')
    return {
      id: text('id'), family,
      defaultFrames: Number(own(block, 'default_frames')),
      fps: family === 'wan_2' && !text('repo').includes('TI2V-5B') ? 16 : 24,
      defaultWidth: Number(own(block, 'default_width')),
      defaultHeight: Number(own(block, 'default_height')),
      negativePrompt: family === 'wan_2' || (family === 'ltx_2' && text('pipeline') !== 'distilled'),
      userSampling: false,
      sizeGB: Number(own(block, 'size_gb')),
      minRamGB: minRam,
      recommendedRamGB: family === 'wan_2' ? Math.max(minRam, 32) : minRam,
      textEncoderGB: encoder === '' ? 0 : encoder === 'LTX23_ABLITERATED_TEXT_ENCODER' ? 6.7 : 8.1,
      starter: own(block, 'starter') === 'true',
      description: block.match(/^\s+description: "(.*)",$/m)?.[1] ?? '',
    }
  })
}

function mockCatalogue(): Row[] {
  const source = read('e2e/support/tauri-mock.ts')
  const start = source.indexOf('const mlxVideoCatalog = [')
  const list = source.slice(start, source.indexOf('\n  ]', start))
  return [...list.matchAll(/^\s+\{ id: '([^']+)',(.*)$/gm)].map(([, id, rest]) => {
    const text = (name: string) => rest.match(new RegExp(`\\b${name}: '?([^,']+)'?,`))?.[1]
    return {
      id, family: text('family') ?? '',
      defaultFrames: Number(text('defaultFrames')),
      fps: Number(text('fps')),
      defaultWidth: Number(text('defaultWidth')),
      defaultHeight: Number(text('defaultHeight')),
      negativePrompt: text('negativePrompt') === 'true',
      userSampling: text('userSampling') !== 'false',
      sizeGB: Number(text('sizeGB')),
      minRamGB: Number(text('minRamGB')),
      // The three the mock's `video_list_models` fills in where a row is silent.
      recommendedRamGB: Number(text('recommendedRamGB') ?? text('minRamGB')),
      textEncoderGB: Number(text('textEncoderGB') ?? 0),
      starter: text('starter') === 'true',
      description: rest.match(/description: '(.*)' \},?$/)?.[1] ?? '',
    }
  })
}

describe('the video catalogue of the browser mock', () => {
  const rust = rustCatalogue()
  const mock = mockCatalogue()

  it('both lists were read, and the rules this file repeats are still the ones in Rust', () => {
    expect(rust.length).toBeGreaterThan(25)
    expect(new Set(rust.map((r) => r.family))).toEqual(new Set(['wan_2', 'ltx_2', 'ltx_2q']))
    const source = read('src-tauri/src/commands/video.rs')
    const rule = (name: string) => { const at = source.indexOf(`fn ${name}(c: &CatalogEntry)`); return source.slice(at, source.indexOf('\n}', at)).replace(/\s+/g, ' ') }
    expect(rule('frame_rate')).toContain('if c.family == "wan_2" && !c.repo.contains("TI2V-5B") { 16 } else { ltx2mlx::FRAME_RATE }')
    expect(rule('takes_negative_prompt')).toContain('match c.family { "wan_2" => true, "ltx_2" => c.pipeline != "distilled", _ => false, }')
    expect(read('src-tauri/src/commands/video_ltx2mlx.rs')).toContain('pub(super) const FRAME_RATE: u32 = 24;')
    expect(source).toContain('"userSampling": false,')
    expect(rule('recommended_ram_gb')).toContain('if c.family == "wan_2" { c.min_ram_gb.max(WAN_T5_MEMORY_GB) } else { c.min_ram_gb }')
    expect(source).toContain('const WAN_T5_MEMORY_GB: u32 = 32;')
    expect(source.slice(source.indexOf('fn text_encoder_gb(repo: &str)'), source.indexOf('/// What a Wan 2.1 fine-tune takes')).replace(/\s+/g, ' '))
      .toContain('if repo == LTX23_ABLITERATED_TEXT_ENCODER { 6.7 } else { 8.1 }')
    // And the mock fills the silent rows in the way this file reads them.
    expect(read('e2e/support/tauri-mock.ts')).toContain('recommendedRamGB: m.minRamGB,\n          textEncoderGB: 0,\n          starter: false,\n          ...m,')
    // Every kind of entry is there, so a rule that stopped applying shows.
    expect(rust.some((r) => r.fps === 16)).toBe(true)
    expect(rust.some((r) => r.family === 'wan_2' && r.fps === 24)).toBe(true)
    expect(rust.some((r) => r.family === 'ltx_2' && r.negativePrompt)).toBe(true)
    expect(rust.some((r) => r.family === 'ltx_2' && !r.negativePrompt)).toBe(true)
  })

  it('names rate, size, negative prompt, sampling, memory and text for every entry, in the order Rust has', () => {
    expect(mock).toEqual(rust)
  })

  it('one starter, first on the mainstream side, and the small Wan says what was measured', () => {
    expect(rust.filter((r) => r.starter).map((r) => r.id)).toEqual(['ltx-2.3-q4'])
    expect(rust[0].id).toBe('ltx-2.3-q4')
    expect(rust[0]).toMatchObject({ sizeGB: 20.5, textEncoderGB: 8.1, minRamGB: 16, recommendedRamGB: 16 })
    const wan = rust.find((r) => r.id === 'wan21-t2v-1.3b')!
    expect(wan).toMatchObject({ minRamGB: 16, recommendedRamGB: 32 })
    expect(wan.description).toMatch(/^Slow on a Mac: about half an hour for five seconds on an M5 Pro, and without sound\./)
    // The fine-tune on the same T5: the same memory, and no measurement of
    // its own to quote.
    const adult = rust.find((r) => r.id === 'nsfw-wan21-1.3b')!
    expect(adult).toMatchObject({ minRamGB: 16, recommendedRamGB: 32 })
    expect(adult.description).toMatch(/Experimental: not yet tested in LU\.$/)
  })
})
