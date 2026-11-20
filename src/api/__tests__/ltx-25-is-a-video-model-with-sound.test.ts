/**
 * LTX 2.5 (Lightricks, open weights since 11.08.2026) in the local Video and
 * Animate lanes. The graph follows the official Comfy-Org templates
 * video_ltx2_5_t2v and video_ltx2_5_i2v (workflow_templates, read 2026-10-02):
 * two sampling passes with a latent upscale in between, picture and sound in
 * one joint latent, CreateVideo muxing both.
 *
 * Run: npx vitest run src/api/__tests__/ltx-25-is-a-video-model-with-sound.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import {
  buildDynamicWorkflow, determineStrategy, snapLtx25Length, WorkflowUnavailableError, LTX25_NEEDS_UPDATE,
} from '../dynamic-workflow'
import { categorizeNodes, detectAvailableModels, getAllNodeInfo } from '../comfyui-nodes'
import {
  classifyModel, isImageModelType, isVideoModelType, isI2VModel, isT2VCapable, findMatchingCLIP, findMatchingVAE,
  COMPONENT_REGISTRY, MODEL_TYPE_DEFAULTS, COMFY_MODEL_FOLDERS,
} from '../comfyui'
import { resolveI2VResolution } from '../vram-handoff'
import { getVideoBundles } from '../discover'
import { localFetch } from '../backend'
import { nodeOf, nodesOf } from './graph-test-support'

const DIT = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'
const DEV = 'ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors'
const ENCODER = 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors'
const VIDEO_VAE = 'ltx-2.5-video-vae-bf16.safetensors'
const AUDIO_VAE = 'ltx-2.5-audio-vae-bf16.safetensors'
const UPSCALER = 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'

const LTX25_NODES: Record<string, unknown> = {
  UNETLoader: { input: { required: { unet_name: [[DIT, DEV]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, AUDIO_VAE]] } } },
  LatentUpscaleModelLoader: { input: { required: { model_name: [[UPSCALER]] } } },
  CLIPTextEncode: { input: { required: {} } },
  LTXVConditioning: { input: { required: {} } },
  EmptyLTXVLatentVideo: { input: { required: {} } },
  LTXVEmptyLatentAudio: { input: { required: {} } },
  LTXVConcatAVLatent: { input: { required: {} } },
  LTXVSeparateAVLatent: { input: { required: {} } },
  LTXVLatentUpsampler: { input: { required: {} } },
  LTXVAudioVAEDecode: { input: { required: {} } },
  LTXVDualCFGGuider: { input: { required: {} } },
  LTXVImgToVideoInplace: { input: { required: {} } },
  LTXVPreprocess: { input: { required: {} } },
  ManualSigmas: { input: { required: {} } },
  KSamplerSelect: { input: { required: {} } },
  RandomNoise: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  VAEDecodeTiled: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  CreateVideo: { input: { required: {} } },
  SaveVideo: { input: { required: {} } },
}

function serveEnums(vaes: string[], clips: string[]) {
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      CLIPLoader: { input: { required: { clip_name: [clips] } } },
      VAELoader: { input: { required: { vae_name: [vaes] } } },
    }),
  } as never)
}

const run = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'two rangers argue at a campfire, then a cut to the lake at dawn', negativePrompt: '',
  sampler: 'euler_ancestral', scheduler: 'simple', steps: 8, cfgScale: 1,
  width: 1280, height: 704, seed: 7, batchSize: 1, frames: 121, fps: 24, ...extra,
}) as never

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(LTX25_NODES as never)
  serveEnums([VIDEO_VAE, AUDIO_VAE], [ENCODER])
})

describe('LTX 2.5 is its own family, not LTX 2.3', () => {
  it('the 2.5 files classify as ltx25, the 2.3 file stays ltx', () => {
    expect(classifyModel(DIT)).toBe('ltx25')
    expect(classifyModel('ltx2.5_distilled.safetensors')).toBe('ltx25')
    expect(classifyModel('LTX_2_5_civitai_repack.safetensors')).toBe('ltx25')
    expect(classifyModel('ltx-2.3-22b-distilled-fp8.safetensors')).toBe('ltx')
    expect(classifyModel('ltx-video-2b-v0.9.5.safetensors')).toBe('ltx')
  })

  it('lands in the video lane for text and for a start image, never in the image picker', () => {
    expect(isVideoModelType('ltx25')).toBe(true)
    expect(isImageModelType('ltx25')).toBe(false)
    expect(isI2VModel(DIT)).toBe(true)
    expect(isT2VCapable(DIT)).toBe(true)
  })

  it('has defaults on the 64 pixel grid, 8k+1 frames and the template fps', () => {
    const d = MODEL_TYPE_DEFAULTS.ltx25
    expect(d.width % 64).toBe(0)
    expect(d.height % 64).toBe(0)
    expect((d.frames - 1) % 8).toBe(0)
    expect(d.fps).toBe(24)
  })

  it('frame counts snap to the 8k+1 grid', () => {
    expect(snapLtx25Length(121)).toBe(121)
    expect(snapLtx25Length(120)).toBe(121)
    expect(snapLtx25Length(97)).toBe(97)
    expect(snapLtx25Length(100)).toBe(97)
    expect(snapLtx25Length(1)).toBe(9)
    expect(snapLtx25Length(Number.NaN)).toBe(121)
  })

  it('a portrait still gets a portrait canvas in the chat tool', () => {
    expect(resolveI2VResolution('ltx25', 0, 0)).toEqual({ width: 1280, height: 704 })
    const portrait = resolveI2VResolution('ltx25', 720, 1280)
    expect(portrait.height).toBeGreaterThan(portrait.width)
    expect(portrait.width % 64).toBe(0)
    expect(portrait.height % 64).toBe(0)
  })
})

describe('the Model Manager offers every file of the official template, from free mirrors', () => {
  const bundles = () => getVideoBundles().filter((b) => b.workflow === 'ltx25')
  const full = () => bundles().find((b) => !b.files.some((f) => f.filename!.endsWith('.gguf')))!
  const small = () => bundles().find((b) => b.files.some((f) => f.filename!.endsWith('.gguf')))!
  /** The official repo is gated: a customer has no token, so no URL may point there. */
  const FREE = /^https:\/\/huggingface\.co\/(comfyicu\/LTX-2\.5|deAPI-ai\/ltx2-5-22b-dist-int8|agosh\/LTX-2\.5-Comfy-GGUF)\/resolve\/main\//

  it('two bundles, the full int8 one first (it is the starter), then the small GGUF one', () => {
    expect(bundles()).toHaveLength(2)
    expect(bundles()[0].name).toBe(full().name)
  })

  it('the full bundle has five files in the folders the loaders read', () => {
    expect(full().files.map((f) => [f.filename, f.subfolder])).toEqual([
      [DIT, 'diffusion_models'],
      [ENCODER, 'text_encoders'],
      [VIDEO_VAE, 'vae'],
      [AUDIO_VAE, 'vae'],
      [UPSCALER, 'latent_upscale_models'],
    ])
  })

  it('the small bundle swaps only the transformer for a Q4 GGUF and asks for ComfyUI-GGUF', () => {
    expect(small().files.slice(1).map((f) => f.filename)).toEqual(full().files.slice(1).map((f) => f.filename))
    expect(small().files[0].filename).toBe('ltx-2.5-22b-distilled-transformer-bf16-Q4_K_M.gguf')
    expect(small().files[0].subfolder).toBe('diffusion_models')
    expect(small().customNodes).toContain('gguf')
    expect(small().totalSizeGB).toBeLessThan(full().totalSizeGB - 8)
    expect(small().vramRequired).toBe('16 GB')
  })

  it('every URL is a free mirror, ends in subfolder/filename and carries a sha256', () => {
    for (const b of bundles()) {
      for (const f of b.files) {
        expect(f.downloadUrl, f.filename).toMatch(FREE)
        expect(f.downloadUrl, f.filename).not.toContain('Lightricks/LTX-2.5/')
        expect(f.downloadUrl!.endsWith(f.filename!), f.filename).toBe(true)
        expect(f.sha256, f.filename).toMatch(/^[0-9a-f]{64}$/)
        expect(f.sizeGB).toBeGreaterThan(0)
      }
    }
  })

  it('sizes are the byte counts of 2026-10-02 in GiB and add up to the totals', () => {
    const bytes: Record<string, number> = {
      [DIT]: 21504034224, [ENCODER]: 15372969374, [VIDEO_VAE]: 1472223346, [AUDIO_VAE]: 364866540, [UPSCALER]: 995778752,
      'ltx-2.5-22b-distilled-transformer-bf16-Q4_K_M.gguf': 12220864608,
    }
    for (const b of bundles()) {
      let sum = 0
      for (const f of b.files) {
        expect(f.sizeGB!, f.filename).toBeCloseTo(bytes[f.filename!] / 1_073_741_824, 2)
        sum += f.sizeGB!
      }
      expect(b.totalSizeGB).toBeCloseTo(sum, 0)
    }
  })

  it('both are best tier and no longer talk about a token', () => {
    for (const b of bundles()) {
      expect(b.tier).toBe('best')
      expect(b.description).not.toMatch(/token/i)
    }
  })

  it('the latent upscaler folder is one the app reads back', () => {
    expect(COMFY_MODEL_FOLDERS.map((f) => f.subfolder)).toContain('latent_upscale_models')
  })

  it('the registry can fetch every companion the builder looks for, from the same free mirrors', () => {
    const r = COMPONENT_REGISTRY.ltx25
    expect([r.vae, r.clip, r.audioVae, r.upscaler].map((s) => s?.downloadFilename)).toEqual([VIDEO_VAE, ENCODER, AUDIO_VAE, UPSCALER])
    for (const s of [r.vae, r.clip, r.audioVae, r.upscaler]) expect(s!.downloadUrl).toMatch(FREE)
  })
})

describe('the graph follows the official templates', () => {
  it('the GGUF file loads through UnetLoaderGGUF, and says so when the pack is missing', async () => {
    const GG = 'ltx-2.5-22b-distilled-transformer-bf16-Q4_K_M.gguf'
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...LTX25_NODES, UnetLoaderGGUF: { input: { required: { unet_name: [[GG]] } } },
    } as never)
    const wf = await buildDynamicWorkflow(run(GG), 'ltx25')
    expect(nodeOf(wf, 'UnetLoaderGGUF')![1].inputs.unet_name).toBe(GG)
    expect(nodeOf(wf, 'UNETLoader')).toBeUndefined()
    // The rest of the graph is the same two pass graph.
    expect(nodesOf(wf, 'SamplerCustomAdvanced')).toHaveLength(2)

    vi.mocked(getAllNodeInfo).mockResolvedValue(LTX25_NODES as never)
    await expect(buildDynamicWorkflow(run(GG), 'ltx25')).rejects.toThrow(/ComfyUI-GGUF/)
  })

  it('text to video: both passes, the upscale between them, sound muxed into the video', async () => {
    const wf = await buildDynamicWorkflow(run(DIT), 'ltx25')

    // Loaders.
    expect(nodeOf(wf, 'UNETLoader')![1].inputs.unet_name).toBe(DIT)
    expect(nodeOf(wf, 'CLIPLoader')![1].inputs).toMatchObject({ clip_name: ENCODER, type: 'ltxv' })
    const vaeOf = (id: unknown) => wf[(id as [string, number])[0]]?.inputs?.vae_name
    expect(nodesOf(wf, 'VAELoader').map(([, n]) => n.inputs.vae_name).sort()).toEqual([AUDIO_VAE, VIDEO_VAE].sort())
    expect(nodeOf(wf, 'LatentUpscaleModelLoader')![1].inputs.model_name).toBe(UPSCALER)

    // Pass 1 starts HALF size, with an empty sound latent of the same length.
    const [emptyId, empty] = nodeOf(wf, 'EmptyLTXVLatentVideo')!
    expect(empty.inputs).toMatchObject({ width: 640, height: 352, length: 121, batch_size: 1 })
    const [audioEmptyId, audioEmpty] = nodeOf(wf, 'LTXVEmptyLatentAudio')!
    expect(audioEmpty.inputs).toMatchObject({ frames_number: 121, frame_rate: 24, batch_size: 1 })
    expect(vaeOf(audioEmpty.inputs.audio_vae)).toBe(AUDIO_VAE)

    const concats = nodesOf(wf, 'LTXVConcatAVLatent')
    expect(concats).toHaveLength(2)
    expect(concats[0][1].inputs).toMatchObject({ video_latent: [emptyId, 0], audio_latent: [audioEmptyId, 0] })

    // Two samplers, the template's two sigma ladders and euler_ancestral.
    const samplers = nodesOf(wf, 'SamplerCustomAdvanced')
    expect(samplers).toHaveLength(2)
    const sigmas = (id: unknown) => wf[(id as [string, number])[0]].inputs!.sigmas
    expect(sigmas(samplers[0][1].inputs.sigmas)).toBe('1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0')
    expect(sigmas(samplers[1][1].inputs.sigmas)).toBe('0.85, 0.7250, 0.4219, 0.0')
    for (const [, s] of samplers) {
      const pick = wf[(s.inputs.sampler as [string, number])[0]]
      expect(pick.class_type).toBe('KSamplerSelect')
      expect(pick.inputs!.sampler_name).toBe('euler_ancestral')
      const guider = wf[(s.inputs.guider as [string, number])[0]]
      expect(guider.class_type).toBe('LTXVDualCFGGuider')
      expect(guider.inputs).toMatchObject({ video_cfg: 1, audio_cfg: 1 })
    }
    expect(samplers[0][1].inputs.latent_image).toEqual([concats[0][0], 0])
    expect(samplers[1][1].inputs.latent_image).toEqual([concats[1][0], 0])

    // Between them: split, upscale the picture, keep the sound, join again.
    const splits = nodesOf(wf, 'LTXVSeparateAVLatent')
    expect(splits).toHaveLength(2)
    expect(splits[0][1].inputs.av_latent).toEqual([samplers[0][0], 0])
    const [upId, up] = nodeOf(wf, 'LTXVLatentUpsampler')!
    expect(up.inputs.samples).toEqual([splits[0][0], 0])
    expect(up.inputs.upscale_model).toEqual([nodeOf(wf, 'LatentUpscaleModelLoader')![0], 0])
    expect(vaeOf(up.inputs.vae)).toBe(VIDEO_VAE)
    expect(concats[1][1].inputs).toMatchObject({ video_latent: [upId, 0], audio_latent: [splits[0][0], 1] })

    // Output: tiled picture decode + audio decode, one CreateVideo with sound.
    expect(splits[1][1].inputs.av_latent).toEqual([samplers[1][0], 0])
    const decode = nodeOf(wf, 'VAEDecodeTiled')![1].inputs
    expect(decode).toMatchObject({ samples: [splits[1][0], 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 })
    expect(vaeOf(decode.vae)).toBe(VIDEO_VAE)
    const [audioDecodeId, audioDecode] = nodeOf(wf, 'LTXVAudioVAEDecode')!
    expect(audioDecode.inputs.samples).toEqual([splits[1][0], 1])
    expect(vaeOf(audioDecode.inputs.audio_vae)).toBe(AUDIO_VAE)
    const create = nodeOf(wf, 'CreateVideo')![1].inputs
    expect(create.fps).toBe(24)
    expect(create.audio).toEqual([audioDecodeId, 0])
    expect(nodeOf(wf, 'SaveVideo')![1].inputs.video).toEqual([nodeOf(wf, 'CreateVideo')![0], 0])

    // Not the 2.3 pipeline.
    expect(nodeOf(wf, 'KSampler')).toBeUndefined()
    expect(nodeOf(wf, 'CheckpointLoaderSimple')).toBeUndefined()
    expect(nodeOf(wf, 'LTXVImgToVideoInplace')).toBeUndefined()
  })

  it('the prompt reaches the encoder and the encoder reaches the conditioning of both guiders', async () => {
    const wf = await buildDynamicWorkflow(run(DIT), 'ltx25')
    const texts = nodesOf(wf, 'CLIPTextEncode')
    expect(texts[0][1].inputs.text).toMatch(/two rangers/)
    const cond = nodeOf(wf, 'LTXVConditioning')!
    expect(cond[1].inputs).toMatchObject({ positive: [texts[0][0], 0], negative: [texts[1][0], 0], frame_rate: 24 })
    for (const [, g] of nodesOf(wf, 'LTXVDualCFGGuider')) {
      expect(g.inputs).toMatchObject({ positive: [cond[0], 0], negative: [cond[0], 1], model: [nodeOf(wf, 'UNETLoader')![0], 0] })
    }
  })

  it('a start image is cut to the canvas and pinned into the first frame in both passes', async () => {
    const wf = await buildDynamicWorkflow(run(DIT, { inputImage: 'still.png' }), 'ltx25')
    const [scaleId, scale] = nodeOf(wf, 'ImageScale')!
    expect(scale.inputs).toMatchObject({ width: 1280, height: 704, crop: 'center' })
    const [prepId, prep] = nodeOf(wf, 'LTXVPreprocess')!
    expect(prep.inputs).toMatchObject({ image: [scaleId, 0], img_compression: 18 })
    const pins = nodesOf(wf, 'LTXVImgToVideoInplace')
    expect(pins).toHaveLength(2)
    // Pass 1: onto the empty half size latent at 0.7. Pass 2: onto the upscaled latent at 1.
    expect(pins[0][1].inputs).toMatchObject({ image: [prepId, 0], latent: [nodeOf(wf, 'EmptyLTXVLatentVideo')![0], 0], strength: 0.7, bypass: false })
    expect(pins[1][1].inputs).toMatchObject({ image: [prepId, 0], latent: [nodeOf(wf, 'LTXVLatentUpsampler')![0], 0], strength: 1, bypass: false })
    const concats = nodesOf(wf, 'LTXVConcatAVLatent')
    expect(concats[0][1].inputs.video_latent).toEqual([pins[0][0], 0])
    expect(concats[1][1].inputs.video_latent).toEqual([pins[1][0], 0])
  })

  it('odd sizes and frame counts are snapped onto the grids the model needs', async () => {
    const wf = await buildDynamicWorkflow(run(DIT, { width: 1000, height: 600, frames: 100, fps: 25 }), 'ltx25')
    expect(nodeOf(wf, 'EmptyLTXVLatentVideo')![1].inputs).toMatchObject({ width: 512, height: 288, length: 97 })
    expect(nodeOf(wf, 'LTXVEmptyLatentAudio')![1].inputs).toMatchObject({ frames_number: 97, frame_rate: 25 })
    expect(nodeOf(wf, 'CreateVideo')![1].inputs.fps).toBe(25)
  })

  it('the dev weights are refused with a sentence, the distilled graph would give noise', async () => {
    const err = await buildDynamicWorkflow(run(DEV), 'ltx25').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String(err.message)).toMatch(/distilled/)
  })
})

describe('the version lock is per model', () => {
  it('an install without LTXVDualCFGGuider (older than 0.32.0) gets the update sentence, in strategy and in the builder', async () => {
    const old = { ...LTX25_NODES }
    delete old.LTXVDualCFGGuider
    expect(LTX25_NEEDS_UPDATE).toBe('LTX 2.5 needs ComfyUI 0.32.0 or newer. Update ComfyUI in Settings.')
    const cats = categorizeNodes(old as never)
    const st = determineStrategy('ltx25', true, cats, detectAvailableModels(old as never))
    expect(st.strategy).toBe('unavailable')
    expect(st.reason).toBe(LTX25_NEEDS_UPDATE)

    vi.mocked(getAllNodeInfo).mockResolvedValue(old as never)
    const err = await buildDynamicWorkflow(run(DIT), 'ltx25').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toBe(LTX25_NEEDS_UPDATE)
    expect(err.needsComfyUpdate).toBe(true)
  })

  it('and a current install gets the lane', () => {
    const st = determineStrategy('ltx25', true, categorizeNodes(LTX25_NODES as never), detectAvailableModels(LTX25_NODES as never))
    expect(st.strategy).toBe('ltx25')
  })

  it('LTX 2.3 is not held to 0.32.0: its own lane still runs without the 2.5 guider', () => {
    const old = { ...LTX25_NODES }
    delete old.LTXVDualCFGGuider
    old.EmptyLTXVLatentVideo = { input: { required: {} } }
    const st = determineStrategy('ltx', true, categorizeNodes(old as never), detectAvailableModels(old as never))
    expect(st.strategy).toBe('unet_ltx')
  })

  it('a missing companion file is named and carries its download', async () => {
    serveEnums([VIDEO_VAE], [ENCODER])
    const err = await buildDynamicWorkflow(run(DIT), 'ltx25').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String(err.message)).toMatch(/ltx-2\.5-audio-vae-bf16/)
    expect(err.missing.map((m: { downloadFilename: string }) => m.downloadFilename)).toEqual([AUDIO_VAE])
  })

  it('a missing upscaler is named and carries its download', async () => {
    const noUp = { ...LTX25_NODES, LatentUpscaleModelLoader: { input: { required: { model_name: [[]] } } } }
    vi.mocked(getAllNodeInfo).mockResolvedValue(noUp as never)
    const err = await buildDynamicWorkflow(run(DIT), 'ltx25').catch((e) => e)
    expect(err.missing.map((m: { downloadFilename: string }) => m.downloadFilename)).toEqual([UPSCALER])
  })
})

describe('the LTX 2.5 files stay out of the other families', () => {
  it('LTX 2.3 takes Gemma 3 and its own VAE, never the 2.5 files', async () => {
    serveEnums([VIDEO_VAE, AUDIO_VAE, 'ltx-2.3-video-vae.safetensors'], [ENCODER, 'gemma_3_12B_it_fp8_scaled.safetensors'])
    expect(await findMatchingCLIP('ltx', 'ltx-2.3-22b-distilled-fp8.safetensors')).toBe('gemma_3_12B_it_fp8_scaled.safetensors')
    expect(await findMatchingVAE('ltx')).toBe('ltx-2.3-video-vae.safetensors')
    serveEnums([VIDEO_VAE], [ENCODER])
    await expect(findMatchingCLIP('ltx', 'ltx-2.3-22b-distilled-fp8.safetensors')).rejects.toThrow(/gemma_3_12B/)
  })

  it('2.5 takes the video VAE for the picture and the LTX Gemma 4 with projection, and says what is missing', async () => {
    expect(await findMatchingVAE('ltx25')).toBe(VIDEO_VAE)
    expect(await findMatchingCLIP('ltx25', DIT)).toBe(ENCODER)
    serveEnums(['ltx-2.5-video-vae-conv-bf16.safetensors', AUDIO_VAE], ['gemma4_12b_int8_convrot.safetensors'])
    await expect(findMatchingVAE('ltx25')).rejects.toThrow(/ltx-2\.5-video-vae-bf16/)
    await expect(findMatchingCLIP('ltx25', DIT)).rejects.toThrow(/gemma4-12b-with-proj-ltx-2\.5/)
  })
})
