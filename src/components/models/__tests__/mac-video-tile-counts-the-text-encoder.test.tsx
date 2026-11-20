/**
 * @vitest-environment jsdom
 *
 * The tile of a Mac video model says what its Get fetches.
 *
 * LTX-2.3 Distilled 4-bit stood on its tile with 19.1 GB, the model alone. A
 * Get on a fresh Mac fetches the text encoder as well, 8.1 GB in a repository
 * of its own, and the progress bar and the setup card of Create had counted
 * it for a while. The list of video models names the encoder only while it is
 * not on disk (`encoder_to_fetch_gb` in video.rs), and the tile adds it.
 *
 * Run: npx vitest run src/components/models/__tests__/mac-video-tile-counts-the-text-encoder.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MacMediaTile, type MacMediaTileState } from '../MacMediaTile'
import { macGetBytes } from '../../../lib/mac-setup-sizes'
import { formatBytes, siGbToBytes } from '../../../lib/formatters'

afterEach(cleanup)

const read = (path: string) => readFileSync(resolve(__dirname, '../../../..', path), 'utf-8')

const ltx = (textEncoderGB: number) => ({
  id: 'ltx-2.3-q4', name: 'LTX-2.3 Distilled 4-bit', repo: 'dgrauet/ltx-2.3-mlx-q4', sizeBytes: siGbToBytes(20.5),
  minRamGB: 16, recommendedRamGB: 16, textEncoderGB, unfiltered: false,
  description: 'The fast LTX-2.3 in 4-bit.',
})
const noop = () => {}
const tile = (model: Parameters<typeof MacMediaTile>[0]['model'], state: MacMediaTileState = { kind: 'idle' }) =>
  render(<MacMediaTile model={model} memoryGb={48} state={state} onGet={noop} onCancel={noop} onRemove={noop} onOpenUrl={noop} />)
const shownSize = (container: HTMLElement) => container.querySelector('[data-tile-size]')?.textContent

describe('the bytes of a Get', () => {
  it('are the model and the encoder the list still names', () => {
    expect(macGetBytes({ sizeBytes: 20.5e9, textEncoderGB: 8.1 })).toBe(28.6e9)
    expect(macGetBytes({ sizeBytes: 20.5e9, textEncoderGB: 0 })).toBe(20.5e9)
    expect(macGetBytes({ sizeBytes: 20.5e9 })).toBe(20.5e9)
  })

  it('an installed model is its own size, whatever the list says beside it', () => {
    expect(macGetBytes({ sizeBytes: 20.5e9, textEncoderGB: 8.1, installed: true })).toBe(20.5e9)
  })
})

describe('the tile of LTX-2.3 Distilled 4-bit', () => {
  it('with no text encoder on this Mac it says model and encoder together', () => {
    const { container } = tile(ltx(8.1))
    expect(shownSize(container)).toBe('26.6 GB')
    expect(screen.getByRole('button', { name: /^Get$/ }).getAttribute('title'))
      .toBe('Install LTX-2.3 Distilled 4-bit (26.6 GB, its text encoder included)')
  })

  it('with the encoder here already it says the model alone', () => {
    const { container } = tile(ltx(0))
    expect(shownSize(container)).toBe('19.1 GB')
    expect(screen.getByRole('button', { name: /^Get$/ }).getAttribute('title')).toBe('Install LTX-2.3 Distilled 4-bit (19.1 GB)')
  })

  it('installed, it says what the model takes and what Remove frees', () => {
    // A stale list could still name the encoder beside an installed model.
    const { container } = tile(ltx(8.1), { kind: 'installed' })
    expect(shownSize(container)).toBe('19.1 GB')
    expect(screen.getByRole('button', { name: 'Remove LTX-2.3 Distilled 4-bit' }).getAttribute('title'))
      .toBe('Remove LTX-2.3 Distilled 4-bit and free 19.1 GB')
  })

  it('a blocked tile keeps the sum: it is still what its Get would fetch', () => {
    const { container } = tile(ltx(8.1), { kind: 'blocked', by: 'Wan 2.1 T2V 1.3B' })
    expect(shownSize(container)).toBe('26.6 GB')
  })
})

describe('every entry that names an encoder, not one model', () => {
  it('an abliterated pack adds its smaller encoder', () => {
    const { container } = tile({ ...ltx(6.7), id: 'ltx-2.3-q4-abliterated', name: 'LTX-2.3 Distilled 4-bit Abliterated' })
    expect(shownSize(container)).toBe(formatBytes(siGbToBytes(20.5 + 6.7)))
    expect(shownSize(container)).toBe('25.3 GB')
  })

  it('a model without the field, as every image model, is unchanged', () => {
    const image = { id: 'sd-turbo', name: 'SD Turbo', repo: 'stabilityai/sd-turbo', sizeBytes: siGbToBytes(2.6), minRamGB: 8, unfiltered: false, description: 'Quick drafts.' }
    const { container } = tile(image)
    expect(shownSize(container)).toBe('2.4 GB')
    expect(screen.getByRole('button', { name: /^Get$/ }).getAttribute('title')).toBe('Install SD Turbo (2.4 GB)')
  })
})

describe('where the number comes from', () => {
  it('the list of video models names the encoder only while a Get has to fetch it', () => {
    const source = read('src-tauri/src/commands/video.rs')
    expect(source).toContain('"textEncoderGB": (encoder_to_fetch_gb(c) * 10.0).round() / 10.0,')
    const at = source.indexOf('fn encoder_to_fetch_gb(entry: &CatalogEntry)')
    expect(source.slice(at, source.indexOf('\n}', at)).replace(/\s+/g, ' '))
      .toContain('if entry.text_encoder_repo.is_empty() || text_encoder_present(&text_encoder_dir(entry.text_encoder_repo)) { 0.0 }')
  })

  it('the browser mock does the same: an installed model takes the encoder off its siblings', () => {
    expect(read('e2e/support/tauri-mock.ts'))
      .toContain('mlx.videos.has(x.id) && !!x.textEncoderGB && x.textEncoderGB === m.textEncoderGB) ? { textEncoderGB: 0 } : {}')
  })
})
