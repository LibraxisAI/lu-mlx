// ─── Text encoders and VAEs of the families the header sniff brought in ───
//
// Discord 2026-09-26..28: Chroma, HiDream, SD 3.5, Lumina 2, Qwen-Image 1 /
// Qwen-Image-Edit, and SDXL / SD 1.5 files that sit in diffusion_models all
// used to fall to the checkpoint loader and fail with "Value not in list".
// Each now has its own pipeline in dynamic-workflow.ts, and this file says
// which companion files that pipeline needs, how to find them in the live
// ComfyUI lists, and where to download them when they are missing.
//
// Every filename and address below is the one the official Comfy-Org
// template for that family names (image_chroma_text_to_image, hidream_i1_*,
// sd3.5_simple_example, image_qwen_image, image_qwen_image_edit_2509,
// Lumina_Image_2.0_Repackaged), checked reachable on 2026-09-28. Pure: the
// builder hands in the enums it already read, so tests need no mocks.

import type { ComponentSpec } from './component-registry'

export type SniffedFamily = 'chroma' | 'hidream' | 'sd3' | 'lumina2' | 'qwenimage1' | 'sdxl_unet' | 'sd15_unet'

interface Part {
  spec: ComponentSpec
  pick: (names: string[]) => string | undefined
}

const lc = (s: string) => s.toLowerCase()
const base = (s: string) => lc(s.split(/[\\/]/).pop() ?? s)
const find = (names: string[], ...tests: Array<(n: string) => boolean>) => {
  for (const t of tests) {
    const hit = names.find((n) => t(base(n)))
    if (hit) return hit
  }
  return undefined
}

const HF = 'https://huggingface.co'
const spec = (downloadFilename: string, url: string | undefined, subfolder: 'vae' | 'text_encoders', sizeGB: number, matchPatterns: string[]): ComponentSpec =>
  ({ downloadFilename, downloadUrl: url, subfolder, sizeGB, matchPatterns })

const T5: Part = {
  spec: spec('t5xxl_fp8_e4m3fn_scaled.safetensors', `${HF}/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors`, 'text_encoders', 5.16, ['t5xxl']),
  pick: (n) => find(n, (b) => b === 't5xxl_fp8_e4m3fn_scaled.safetensors', (b) => b.includes('t5xxl'), (b) => b.includes('t5') && !b.includes('umt5') && !b.includes('oldt5')),
}
const CLIP_L: Part = {
  spec: spec('clip_l.safetensors', `${HF}/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors`, 'text_encoders', 0.25, ['clip_l']),
  pick: (n) => find(n, (b) => b === 'clip_l.safetensors', (b) => b.includes('clip_l')),
}
const CLIP_G: Part = {
  spec: spec('clip_g.safetensors', `${HF}/Comfy-Org/stable-diffusion-3.5-fp8/resolve/main/text_encoders/clip_g.safetensors`, 'text_encoders', 1.39, ['clip_g']),
  pick: (n) => find(n, (b) => b === 'clip_g.safetensors', (b) => b.includes('clip_g')),
}
const AE: Part = {
  spec: spec('ae.safetensors', `${HF}/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors`, 'vae', 0.34, ['ae']),
  // The 16-channel FLUX autoencoder. Never the FLUX 2 one (32 channels).
  pick: (n) => find(n, (b) => b === 'ae.safetensors', (b) => /(^|[._-])ae[._-]/.test(b) && !b.includes('flux2'), (b) => b.includes('flux') && !b.includes('flux2')),
}

const HIDREAM_CLIP_L: Part = {
  spec: spec('clip_l_hidream.safetensors', `${HF}/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/text_encoders/clip_l_hidream.safetensors`, 'text_encoders', 0.25, ['clip_l_hidream', 'clip_l']),
  pick: (n) => find(n, (b) => b.includes('clip_l_hidream'), (b) => b.includes('clip_l')),
}
const HIDREAM_CLIP_G: Part = {
  spec: spec('clip_g_hidream.safetensors', `${HF}/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/text_encoders/clip_g_hidream.safetensors`, 'text_encoders', 1.39, ['clip_g_hidream', 'clip_g']),
  pick: (n) => find(n, (b) => b.includes('clip_g_hidream'), (b) => b.includes('clip_g')),
}
const LLAMA: Part = {
  spec: spec('llama_3.1_8b_instruct_fp8_scaled.safetensors', `${HF}/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/text_encoders/llama_3.1_8b_instruct_fp8_scaled.safetensors`, 'text_encoders', 9.08, ['llama_3.1']),
  pick: (n) => find(n, (b) => /llama[._-]?3[._]1/.test(b), (b) => b.includes('llama') && !b.includes('llava')),
}
const GEMMA_2B: Part = {
  spec: spec('gemma_2_2b_fp16.safetensors', `${HF}/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/text_encoders/gemma_2_2b_fp16.safetensors`, 'text_encoders', 5.23, ['gemma_2_2b']),
  pick: (n) => find(n, (b) => b.includes('gemma_2_2b') || b.includes('gemma-2-2b'), (b) => b.includes('gemma') && b.includes('2b') && !/gemma[._-]?3/.test(b)),
}
const QWEN25_VL: Part = {
  spec: spec('qwen_2.5_vl_7b_fp8_scaled.safetensors', `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`, 'text_encoders', 9.38, ['qwen_2.5_vl']),
  pick: (n) => find(n, (b) => /qwen[._-]?2[._]5[._-]?vl/.test(b)),
}
const QWEN_IMAGE_VAE: Part = {
  spec: spec('qwen_image_vae.safetensors', `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors`, 'vae', 0.25, ['qwen_image_vae']),
  // The 16-channel Qwen-Image 1 autoencoder, never the 64-channel 2.1 one.
  pick: (n) => find(n, (b) => b === 'qwen_image_vae.safetensors', (b) => b.includes('qwen_image') && b.includes('vae') && !/2[._-]?1/.test(b)),
}
const SDXL_VAE: Part = {
  spec: spec('sdxl_vae.safetensors', `${HF}/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors`, 'vae', 0.33, ['sdxl']),
  pick: (n) => find(n, (b) => b.includes('sdxl') || b.includes('sd_xl')),
}
const SD15_VAE: Part = {
  spec: spec('vae-ft-mse-840000-ema-pruned.safetensors', `${HF}/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors`, 'vae', 0.33, ['ft-mse']),
  pick: (n) => find(n, (b) => b.includes('ft-mse') || b.includes('840000'), (b) => b.includes('sd15') || b.includes('v1-5') || b.includes('sd-v1')),
}
// No ungated standalone SD 3.5 VAE exists; SD 3.5 ships as all-in-one
// checkpoints that carry it, and only a bare transformer needs this.
const SD3_VAE: Part = {
  spec: spec('sd3_vae.safetensors', undefined, 'vae', 0.17, ['sd3']),
  pick: (n) => find(n, (b) => b.includes('sd3') || b.includes('sd3.5')),
}

/** Encoders in loader order, then the VAE. */
export const FAMILY_PARTS: Record<SniffedFamily, { encoders: Part[]; vae: Part }> = {
  chroma: { encoders: [T5], vae: AE },
  hidream: { encoders: [HIDREAM_CLIP_L, HIDREAM_CLIP_G, T5, LLAMA], vae: AE },
  sd3: { encoders: [CLIP_L, CLIP_G, T5], vae: SD3_VAE },
  lumina2: { encoders: [GEMMA_2B], vae: AE },
  qwenimage1: { encoders: [QWEN25_VL], vae: QWEN_IMAGE_VAE },
  sdxl_unet: { encoders: [CLIP_L, CLIP_G], vae: SDXL_VAE },
  sd15_unet: { encoders: [CLIP_L], vae: SD15_VAE },
}

const LABEL: Record<SniffedFamily, string> = {
  chroma: 'Chroma', hidream: 'HiDream', sd3: 'SD 3.5', lumina2: 'Lumina 2',
  qwenimage1: 'Qwen-Image', sdxl_unet: 'SDXL', sd15_unet: 'SD 1.5',
}

/** Thrown when companion files are missing. Carries what to fetch, so Create
 *  can offer the download in place instead of sending people to the Model
 *  Manager. */
export class MissingComponentsError extends Error {
  readonly missing: ComponentSpec[]
  constructor(message: string, missing: ComponentSpec[]) {
    super(message)
    this.name = 'MissingComponentsError'
    this.missing = missing
  }
}

export function resolveFamilyParts(
  family: SniffedFamily,
  clips: string[],
  vaes: string[],
  need: { encoders: boolean; vae: boolean } = { encoders: true, vae: true },
): { encoders: string[]; vae?: string } {
  const parts = FAMILY_PARTS[family]
  const missing: ComponentSpec[] = []
  const encoders: string[] = []
  if (need.encoders) {
    for (const p of parts.encoders) {
      const hit = p.pick(clips)
      if (hit) encoders.push(hit)
      else missing.push(p.spec)
    }
  }
  let vae: string | undefined
  if (need.vae) {
    vae = parts.vae.pick(vaes)
    if (!vae) missing.push(parts.vae.spec)
  }
  if (missing.length > 0) {
    throw new MissingComponentsError(
      `${LABEL[family]} needs ${missing.map((m) => `"${m.downloadFilename}"`).join(', ')}.`,
      missing,
    )
  }
  return { encoders, vae }
}
