import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BundleTile } from '../ModelTiles'
import { getImageBundles, getVideoBundles } from '../../../api/model-bundles'
import { bundleGetPlan, catalogFileBytes } from '../../../lib/bundle-state'
import { formatBytes } from '../../../lib/formatters'

// The box, 03.10.2026: "Qwen-Image 2.1 (No Filter)" and "Noct Q" read
// "Get · 16.1 GB" and "Install 3 files (16.1 GB)". Two of the three files are
// shared with the official bundle and were there already; the click fetched
// one file of 8.7 GB. A card announces what the click will fetch.

const all = () => [...getImageBundles(), ...getVideoBundles()]
const bundle = (name: string) => all().find((b) => b.name === name)!

function tile(name: string, filesOnDisk?: Set<string>): string {
  return renderToStaticMarkup(
    <BundleTile
      bundle={bundle(name)} vramGb={12} complete={false} filesOnDisk={filesOnDisk}
      downloading={false} hasErrors={false}
      onInstall={() => {}} onRetry={() => {}} onClear={() => {}} onOpenUrl={() => {}}
    />,
  )
}

const SHARED = new Set(['qwen_image_2.1_int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors'])

describe('a bundle card announces what Get will fetch', () => {
  it('No Filter with the official bundle installed: one file, the encoder', () => {
    const html = tile('Qwen-Image 2.1 (No Filter)', SHARED)
    expect(html).toContain('Get · 8.7 GB')
    expect(html).toContain('title="Install 1 file (8.7 GB), 2 already here"')
    expect(html).not.toContain('Get · 16.1 GB')
  })

  it('Noct Q with the official bundle installed: one file, the image model', () => {
    const html = tile('Noct Q (Qwen-Image 2.1, Unfiltered)', SHARED)
    expect(html).toContain('Get · 6.8 GB')
    expect(html).toContain('title="Install 1 file (6.8 GB), 2 already here"')
  })

  it('with nothing on disk the whole bundle is announced', () => {
    const html = tile('Qwen-Image 2.1 (No Filter)')
    expect(html).toContain('Get · 16.1 GB')
    expect(html).toContain('title="Install 3 files (16.1 GB)"')
    expect(html).not.toContain('already here')
  })

  it('the card still names the size of the whole bundle next to the file count', () => {
    const html = tile('Qwen-Image 2.1 (No Filter)', SHARED)
    expect(html).toMatch(/16\.1 GB<\/span><span[^>]*>3 files/)
  })

  it('LTX 2.5 Small with two of five files there: the three missing ones, 27.1 GB', () => {
    const onDisk = new Set(['ltx-2.5-audio-vae-bf16.safetensors', 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'])
    const html = tile('LTX 2.5 · Small (GGUF Q4)', onDisk)
    expect(html).toContain('Get · 27.1 GB')
    expect(html).toContain('title="Install 3 files (27.1 GB), 2 already here"')
  })
})

describe('sizes are summed from the files, in bytes', () => {
  it('LTX 2.5 Small is the sum of its five byte counts, not a rounded total', () => {
    const b = bundle('LTX 2.5 · Small (GGUF Q4)')
    const sum = b.files.reduce((n, f) => n + catalogFileBytes(f), 0)
    expect(bundleGetPlan(b, new Set()).totalBytes).toBe(sum)
    expect(b.files.every((f) => f.sizeBytes != null)).toBe(true)
    expect(tile(b.name)).toContain(`Get · ${formatBytes(sum)}`)
  })

  it('an exact byte count wins over the rounded sizeGB', () => {
    expect(catalogFileBytes({ sizeGB: 11.38, sizeBytes: 12220864608 })).toBe(12220864608)
    expect(catalogFileBytes({ sizeGB: 0.5 })).toBe(536870912)
    expect(catalogFileBytes({})).toBe(0)
  })

  it('files on disk that ComfyUI does not list: Get names the whole bundle again', () => {
    const b = bundle('Qwen-Image 2.1 (No Filter)')
    const everything = new Set(b.files.map((f) => f.filename!))
    const plan = bundleGetPlan(b, everything)
    expect(plan.fetchFiles).toBe(3)
    expect(plan.present).toBe(0)
  })
})
