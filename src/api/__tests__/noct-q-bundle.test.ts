/**
 * Noct Q in the Model Manager: a community finetune of Qwen-Image 2.1 as its
 * own bundle next to the two Qwen-Image 2.1 bundles.
 *
 * Read off Hugging Face on 2026-10-03 without a token (model API, tree API,
 * NOTICE, model card, HEAD on the file, and the safetensors headers by Range):
 *   - Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1: not gated, not private,
 *     licence "qwen-research", base model Qwen/Qwen-Image-2.1
 *   - NoctQ_V4_int8_convrot.safetensors, 7256784368 bytes, lfs.oid 4d92d553...
 *   - NOTICE: "the Qwen-Image-2.1 transformer weights were modified by noctaluna"
 *   - the card names the official text encoder and the official VAE
 *   - header: 649 tensors, names, shapes and data types equal to the official
 *     qwen_image_2.1_int8_convrot.safetensors (192 I8, 192 U8, 192 F32, 73 BF16)
 *
 * That the lane runs the file is in the tests parametrised over both weights
 * (qwen-image-21-workflow, -transparent, -no-refusals, the two useCreate tests).
 *
 * Run: npx vitest run src/api/__tests__/noct-q-bundle.test.ts
 */
import { describe, it, expect } from 'vitest'
import { getImageBundles } from '../discover'
import { classifyModel } from '../comfyui'
import { localTier } from '../../lib/render/local-model-tier'
import { NOCT_Q_MODEL } from './qwen21-weights'

const all = getImageBundles()
const official = all.find((b) => b.name === 'Qwen-Image 2.1 (Generate and Edit)')!
const noRefusals = all.find((b) => b.name === 'Qwen-Image 2.1 (No Filter)')!
const bundle = all.find((b) => b.name === 'Noct Q (Qwen-Image 2.1, Unfiltered)')!
const file = (b: typeof bundle, folder: string) => b.files.find((f) => f.subfolder === folder)!

describe('bundle Noct Q (Qwen-Image 2.1, Unfiltered)', () => {
  it('exists once, under Image, right after the two Qwen-Image 2.1 bundles', () => {
    expect(all.filter((b) => b.name === bundle.name)).toHaveLength(1)
    expect(all.indexOf(noRefusals)).toBe(all.indexOf(official) + 1)
    expect(all.indexOf(bundle)).toBe(all.indexOf(noRefusals) + 1)
    expect(bundle.workflow).toBe('qwenimage')
  })

  it('is in the list of unfiltered models and is not marked verified', () => {
    expect(bundle.uncensored).toBe(true)
    expect(bundle.verified).toBeUndefined()
    expect(bundle.tags).toContain('Unfiltered')
  })

  it('the image model is the V4 file, with byte count and SHA-256, in diffusion_models', () => {
    const model = file(bundle, 'diffusion_models')
    expect(bundle.files).toHaveLength(3)
    expect(model.filename).toBe(NOCT_Q_MODEL)
    expect(model.downloadUrl).toBe(`https://huggingface.co/Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1/resolve/main/${NOCT_Q_MODEL}`)
    expect(model.sizeBytes).toBe(7_256_784_368)
    expect(model.sha256).toBe('4d92d5538253ab36e6a73b056cce5f697950f4303cb9e6686a3198d0ea13f9e8')
    expect(Math.abs(model.sizeGB! - 7_256_784_368 / 1_073_741_824)).toBeLessThan(0.01)
  })

  it('the catalogue file is recognised as Qwen-Image 2.1, at the tier of the bundle', () => {
    const type = classifyModel(file(bundle, 'diffusion_models').filename)
    expect(type).toBe(bundle.workflow)
    expect(localTier({ name: NOCT_Q_MODEL, type })).toBe(bundle.tier)
  })

  it('the text encoder and the VAE are the very entries of the official bundle', () => {
    expect(file(bundle, 'text_encoders')).toBe(file(official, 'text_encoders'))
    expect(file(bundle, 'vae')).toBe(file(official, 'vae'))
    expect(file(bundle, 'vae')).toBe(file(noRefusals, 'vae'))
    expect(file(bundle, 'text_encoders').filename).toBe('qwen3vl_8b_int8_convrot.safetensors')
  })

  it('the total is the sum of its three files', () => {
    const sum = bundle.files.reduce((n, f) => n + f.sizeGB!, 0)
    expect(Math.abs(bundle.totalSizeGB - sum)).toBeLessThan(0.05)
  })

  it('tier, VRAM figure and numbers are those of the official bundle', () => {
    expect(bundle.tier).toBe(official.tier)
    expect(bundle.vramRequired).toBe(official.vramRequired)
    expect(bundle.vramMinGB).toBe(official.vramMinGB)
    expect(bundle.vramComfortGB).toBe(official.vramComfortGB)
    expect(bundle.customNodes).toBeUndefined()
  })

  it('says what it is, what was changed, what is shared, and the licence', () => {
    const d = bundle.description
    expect(d).toContain('A community finetune of Qwen-Image 2.1 by Noctaluna')
    expect(d).toContain('the Qwen-Image 2.1 transformer weights were modified')
    expect(d).toContain('The text encoder and the VAE are the official files')
    expect(d).toContain('Qwen Research License, non-commercial use: https://huggingface.co/Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1/blob/main/LICENSE')
  })

  it('makes no quality or speed claim, names nothing explicit, and has no dash', () => {
    const texts = [bundle.name, bundle.description, ...bundle.tags, ...bundle.files.flatMap((f) => [f.name, f.description])]
    // The repository address carries the name its author gave it; the words
    // the app writes itself are what is checked.
    for (const text of texts.map((t) => t.replace(/https:\/\/\S+/g, ''))) {
      expect(text).not.toMatch(/[\u2013\u2014]/)
      expect(text).not.toMatch(/faster|better|sharper|quality|realis|stunning|best/i)
      expect(text).not.toMatch(/nsfw|nud|explicit|uncensored|adult|porn|sex/i)
    }
  })
})
