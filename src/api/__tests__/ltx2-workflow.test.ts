/**
 * LTX-2 / 2.3 local lane (buildLtx2Workflow).
 *
 * The bug that opened this lane: picking an LTX-2.3 GGUF (PinkCherry) sent a
 * graph ComfyUI refused before running anything:
 *
 *   LTXVImgToVideo 7:  Return type mismatch … vae, received_type(MODEL) mismatch input_type(VAE)
 *   VAEDecodeTiled 9:  Return type mismatch … vae, received_type(MODEL) mismatch input_type(VAE)
 *
 * The generic LTX path never loaded a VAE and pointed every vae input at the
 * UNET loader. It was also the LTX-Video 0.9 graph (KSampler on a video-only
 * latent), which an audio+video LTX-2 model cannot run even with the link fixed.
 *
 * The main check here is the one ComfyUI itself runs in validate_inputs: every
 * link's source output type must be accepted by the input it feeds, and every
 * required input must be set. SCHEMA is read off the live /object_info of a
 * ComfyUI v0.37.0-15-gb5cc883 (2026-09-24), input and output types only.
 *
 * Run: npx vitest run src/api/__tests__/ltx2-workflow.test.ts
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

import { buildDynamicWorkflow, snapLtx2Length } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { isLtx2Model, classifyModel } from '../comfyui'
import type { ComfyApiGraph } from '../../types/comfy-graph'
import { nodeOf, type BuiltNode } from './graph-test-support'

/** The first node of this class; a missing one fails the test by name. */
function node(wf: ComfyApiGraph, klass: string): BuiltNode {
  const hit = nodeOf(wf, klass)
  if (!hit) throw new Error(`graph has no ${klass}`)
  return hit[1]
}

type Sig = { req: Record<string, string>; opt: Record<string, string>; out: string[] }

const SCHEMA: Record<string, Sig> = {
  UnetLoaderGGUF: { req: { unet_name: 'COMBO' }, opt: {}, out: ['MODEL'] },
  UNETLoader: { req: { unet_name: 'COMBO', weight_dtype: 'COMBO' }, opt: {}, out: ['MODEL'] },
  CLIPLoader: { req: { clip_name: 'COMBO', type: 'COMBO' }, opt: { device: 'COMBO' }, out: ['CLIP'] },
  CheckpointLoaderSimple: { req: { ckpt_name: 'COMBO' }, opt: {}, out: ['MODEL', 'CLIP', 'VAE'] },
  VAELoader: { req: { vae_name: 'COMBO' }, opt: {}, out: ['VAE'] },
  DualCLIPLoader: { req: { clip_name1: 'COMBO', clip_name2: 'COMBO', type: 'COMBO' }, opt: { device: 'COMBO' }, out: ['CLIP'] },
  LTXAVTextEncoderLoader: { req: { text_encoder: 'COMBO', ckpt_name: 'COMBO', device: 'COMBO' }, opt: {}, out: ['CLIP'] },
  LTXVAudioVAELoader: { req: { ckpt_name: 'COMBO' }, opt: {}, out: ['VAE'] },
  LoraLoaderModelOnly: { req: { model: 'MODEL', lora_name: 'COMBO', strength_model: 'FLOAT' }, opt: {}, out: ['MODEL'] },
  CLIPTextEncode: { req: { text: 'STRING', clip: 'CLIP' }, opt: {}, out: ['CONDITIONING'] },
  LTXVConditioning: { req: { positive: 'CONDITIONING', negative: 'CONDITIONING', frame_rate: 'FLOAT' }, opt: {}, out: ['CONDITIONING', 'CONDITIONING'] },
  EmptyLTXVLatentVideo: { req: { width: 'INT', height: 'INT', length: 'INT', batch_size: 'INT' }, opt: {}, out: ['LATENT'] },
  LoadImage: { req: { image: 'COMBO' }, opt: {}, out: ['IMAGE', 'MASK'] },
  LTXVPreprocess: { req: { image: 'IMAGE', img_compression: 'INT' }, opt: {}, out: ['IMAGE'] },
  LTXVImgToVideoInplace: { req: { vae: 'VAE', image: 'IMAGE', latent: 'LATENT', strength: 'FLOAT', bypass: 'BOOLEAN' }, opt: {}, out: ['LATENT'] },
  LTXVEmptyLatentAudio: { req: { frames_number: 'INT', frame_rate: 'FLOAT,INT', batch_size: 'INT', audio_vae: 'VAE' }, opt: {}, out: ['LATENT'] },
  LTXVConcatAVLatent: { req: { video_latent: 'LATENT', audio_latent: 'LATENT' }, opt: {}, out: ['LATENT'] },
  ManualSigmas: { req: { sigmas: 'STRING' }, opt: {}, out: ['SIGMAS'] },
  LTXVScheduler: { req: { steps: 'INT', max_shift: 'FLOAT', base_shift: 'FLOAT', stretch: 'BOOLEAN', terminal: 'FLOAT' }, opt: { latent: 'LATENT' }, out: ['SIGMAS'] },
  RandomNoise: { req: { noise_seed: 'INT' }, opt: {}, out: ['NOISE'] },
  KSamplerSelect: { req: { sampler_name: 'COMBO' }, opt: {}, out: ['SAMPLER'] },
  CFGGuider: { req: { model: 'MODEL', positive: 'CONDITIONING', negative: 'CONDITIONING', cfg: 'FLOAT' }, opt: {}, out: ['GUIDER'] },
  SamplerCustomAdvanced: { req: { noise: 'NOISE', guider: 'GUIDER', sampler: 'SAMPLER', sigmas: 'SIGMAS', latent_image: 'LATENT' }, opt: {}, out: ['LATENT', 'LATENT'] },
  LTXVSeparateAVLatent: { req: { av_latent: 'LATENT' }, opt: {}, out: ['LATENT', 'LATENT'] },
  VAEDecodeTiled: { req: { samples: 'LATENT', vae: 'VAE', tile_size: 'INT', overlap: 'INT', temporal_size: 'INT', temporal_overlap: 'INT' }, opt: {}, out: ['IMAGE'] },
  VAEDecode: { req: { samples: 'LATENT', vae: 'VAE' }, opt: {}, out: ['IMAGE'] },
  LTXVAudioVAEDecode: { req: { samples: 'LATENT', audio_vae: 'VAE' }, opt: {}, out: ['AUDIO'] },
  CreateVideo: { req: { images: 'IMAGE', fps: 'FLOAT' }, opt: { audio: 'AUDIO', bit_depth: 'COMBO', color_space: 'COMBO', codec: 'COMBO' }, out: ['VIDEO'] },
  SaveVideo: { req: { video: 'VIDEO', filename_prefix: 'STRING', format: 'COMFY_DYNAMICCOMBO_V3' }, opt: { codec: 'COMFY_DYNAMICCOMBO_V3' }, out: ['VIDEO'] },
}

const GGUF = 'PinkCherry_FineTune_Q8_0_v1_8_LTX23.gguf'
const GEMMA = 'gemma_3_12B_it_fp8_scaled.safetensors'
const PROJECTION = 'ltx-2.3_text_projection_bf16.safetensors'
const VIDEO_VAE = 'LTX23_video_vae_bf16.safetensors'
const AUDIO_VAE = 'LTX23_audio_vae_bf16.safetensors'
const CKPT = 'ltx-2.3-22b-distilled-fp8.safetensors'

/** An /object_info built from SCHEMA, with the loader lists a test needs. */
function objectInfo(lists: { unets?: string[]; ckpts?: string[]; vaes?: string[]; clips?: string[] } = {}) {
  const combos: Record<string, Record<string, string[]>> = {
    UnetLoaderGGUF: { unet_name: lists.unets ?? [GGUF] },
    UNETLoader: { unet_name: [], weight_dtype: ['default'] },
    CheckpointLoaderSimple: { ckpt_name: lists.ckpts ?? [] },
    LTXVAudioVAELoader: { ckpt_name: lists.ckpts ?? [] },
    LTXAVTextEncoderLoader: { text_encoder: lists.clips ?? [GEMMA, PROJECTION], ckpt_name: lists.ckpts ?? [], device: ['default', 'cpu'] },
    VAELoader: { vae_name: lists.vaes ?? [AUDIO_VAE, VIDEO_VAE, 'taeltx2_3.safetensors'] },
    CLIPLoader: { clip_name: lists.clips ?? [GEMMA, PROJECTION], type: ['ltxv'], device: ['default'] },
    DualCLIPLoader: { clip_name1: lists.clips ?? [GEMMA, PROJECTION], clip_name2: lists.clips ?? [GEMMA, PROJECTION], type: ['flux', 'ltxv'], device: ['default'] },
    KSamplerSelect: { sampler_name: ['euler', 'euler_ancestral'] },
  }
  const info: Record<string, unknown> = {}
  for (const [name, sig] of Object.entries(SCHEMA)) {
    const spec = (fields: Record<string, string>) =>
      Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, t === 'COMBO' ? [combos[name]?.[k] ?? []] : [t]]))
    info[name] = { input: { required: spec(sig.req), optional: spec(sig.opt) }, output: sig.out }
  }
  return info
}

/** What ComfyUI's validate_inputs would say about this graph. */
function validationErrors(wf: ComfyApiGraph): string[] {
  const errors: string[] = []
  for (const [id, node] of Object.entries(wf)) {
    const sig = SCHEMA[node.class_type]
    if (!sig) { errors.push(`${id} ${node.class_type}: node not in the schema`); continue }
    const inputs = node.inputs ?? {}
    for (const k of Object.keys(sig.req)) {
      if (inputs[k] === undefined) errors.push(`${id} ${node.class_type}: required input ${k} missing`)
    }
    for (const [k, v] of Object.entries(inputs)) {
      const want = sig.req[k] ?? sig.opt[k]
      if (!want) { errors.push(`${id} ${node.class_type}: ${k} is not an input`); continue }
      if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'number') continue
      const src = wf[v[0]]
      if (!src) { errors.push(`${id} ${node.class_type}.${k}: links to missing node ${v[0]}`); continue }
      const got = SCHEMA[src.class_type]?.out[v[1]]
      if (!want.split(',').includes(got ?? '')) {
        errors.push(`${id} ${node.class_type}.${k}: received_type(${got}) from ${src.class_type}[${v[1]}], input_type(${want})`)
      }
    }
  }
  return errors
}

const params = {
  model: GGUF,
  prompt: 'a lighthouse on a cliff at dusk, waves, wind', negativePrompt: 'blurry',
  sampler: 'euler', scheduler: 'normal',
  steps: 20, cfgScale: 3, width: 768, height: 512, seed: 42, batchSize: 1,
  frames: 97, fps: 24,
}

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockReset()
  vi.mocked(localFetch).mockReset()
})

/** /system_stats of a ComfyUI computing on this torch device. */
function onDevice(type: string) {
  vi.mocked(localFetch).mockImplementation(async (url: string) =>
    url.endsWith('/system_stats')
      ? new Response(JSON.stringify({ devices: [{ type, name: type }] }), { status: 200 })
      : new Response('{}', { status: 404 }))
}

describe('validationErrors (negative control)', () => {
  it('catches the exact graph ComfyUI refused: MODEL wired into a vae input', () => {
    const broken: ComfyApiGraph = {
      '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: GGUF } },
      '2': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: 768, height: 512, length: 97, batch_size: 1 } },
      '9': { class_type: 'VAEDecodeTiled', inputs: { samples: ['2', 0], vae: ['1', 0], tile_size: 256, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    }
    expect(validationErrors(broken)).toEqual([
      '9 VAEDecodeTiled.vae: received_type(MODEL) from UnetLoaderGGUF[0], input_type(VAE)',
    ])
  })
})

describe('isLtx2Model', () => {
  it('knows the LTX-2 spellings', () => {
    for (const f of [GGUF, CKPT, 'ltx2_19b_dev.safetensors', 'LTX-2-distilled.gguf', 'ltxav_q8.gguf']) {
      expect(isLtx2Model(f), f).toBe(true)
      expect(classifyModel(f), f).toBe('ltx')
    }
  })
  it('leaves LTX-Video 0.9 alone', () => {
    for (const f of ['ltx-video-2b-v0.9.5.safetensors', 'ltxv-13b-0.9.7-dev.safetensors', 'ltxv-2b-0.9.6-distilled.safetensors']) {
      expect(isLtx2Model(f), f).toBe(false)
    }
  })
})

describe('snapLtx2Length', () => {
  it('lands on the 8k+1 grid', () => {
    expect(snapLtx2Length(97)).toBe(97)
    expect(snapLtx2Length(96)).toBe(97)
    expect(snapLtx2Length(120)).toBe(121)
    expect(snapLtx2Length(0)).toBe(97)
    for (const f of [10, 33, 50, 121, 200]) expect((snapLtx2Length(f) - 1) % 8).toBe(0)
  })
})

describe('LTX-2 split install (GGUF in diffusion_models, Kijai split files)', () => {
  it('passes ComfyUI validation: no MODEL on a vae input, nothing required missing', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    const wf = await buildDynamicWorkflow(params)
    expect(validationErrors(wf)).toEqual([])
  })

  it('loads the model, both VAEs and Gemma + projection the way the author workflow does', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    const wf = await buildDynamicWorkflow(params)
    expect(node(wf, 'UnetLoaderGGUF').inputs.unet_name).toBe(GGUF)
    const vaes = Object.values(wf).filter((n) => n.class_type === 'VAELoader').map((n) => n.inputs?.vae_name)
    expect(vaes.sort()).toEqual([AUDIO_VAE, VIDEO_VAE].sort())
    expect(node(wf, 'DualCLIPLoader').inputs).toMatchObject({ clip_name1: GEMMA, clip_name2: PROJECTION, type: 'ltxv' })
  })

  it('decodes video with the VIDEO vae and sound with the AUDIO vae, and muxes the sound in', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    const wf = await buildDynamicWorkflow(params)
    const vaeName = (ref: unknown) => wf[(ref as [string, number])[0]]?.inputs?.vae_name
    expect(vaeName(node(wf, 'VAEDecodeTiled').inputs.vae)).toBe(VIDEO_VAE)
    expect(vaeName(node(wf, 'LTXVAudioVAEDecode').inputs.audio_vae)).toBe(AUDIO_VAE)
    expect(vaeName(node(wf, 'LTXVEmptyLatentAudio').inputs.audio_vae)).toBe(AUDIO_VAE)
    expect(node(wf, 'CreateVideo').inputs.audio).toBeDefined()
    expect(node(wf, 'SaveVideo')).toBeDefined()
  })

  it('image-to-video encodes the start frame into the video latent before it joins the audio', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    const wf = await buildDynamicWorkflow({ ...params, inputImage: 'start.png' })
    expect(validationErrors(wf)).toEqual([])
    const i2v = Object.entries(wf).find(([, n]) => n.class_type === 'LTXVImgToVideoInplace')
    expect(i2v).toBeDefined()
    expect(node(wf, 'LTXVConcatAVLatent').inputs.video_latent).toEqual([i2v![0], 0])
    expect(node(wf, 'LoadImage').inputs.image).toBe('start.png')
  })

  it('a non-distilled file samples with LTXVScheduler at the user cfg; a distilled one with the 8-step schedule at cfg 1', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    const dev = await buildDynamicWorkflow(params)
    expect(node(dev, 'LTXVScheduler').inputs.steps).toBe(20)
    expect(node(dev, 'CFGGuider').inputs.cfg).toBe(3)

    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo({ unets: ['ltx-2.3-22b-distilled-Q8_0.gguf'] }) as never)
    const distilled = await buildDynamicWorkflow({ ...params, model: 'ltx-2.3-22b-distilled-Q8_0.gguf' })
    expect(node(distilled, 'ManualSigmas').inputs.sigmas).toMatch(/^1\.0, .*0\.0$/)
    expect(node(distilled, 'CFGGuider').inputs.cfg).toBe(1)
  })

  it('size and length land on the LTX-2 grid', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    const wf = await buildDynamicWorkflow({ ...params, width: 770, height: 500, frames: 100 })
    expect(node(wf, 'EmptyLTXVLatentVideo').inputs).toMatchObject({ width: 768, height: 512, length: 97 })
    expect(node(wf, 'LTXVEmptyLatentAudio').inputs.frames_number).toBe(97)
  })

  it('says which split files are missing instead of sending a graph ComfyUI will refuse', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo({ vaes: [VIDEO_VAE], clips: [GEMMA] }) as never)
    await expect(buildDynamicWorkflow(params)).rejects.toThrow(/LTX23_audio_vae_bf16.*ltx-2\.3_text_projection/)
  })
})

describe('LTX-2 image-to-video cfg on MPS', () => {
  // Measured on ComfyUI 0.37 / MPS: I2V above cfg 1 decodes to NaN (black
  // frames, silent audio, SaveVideo dies in the AAC encoder). Comfy-Org's own
  // LTX-2 i2v template runs cfg 4, so only MPS gets the clamp.
  it('runs image-to-video at cfg 1 on an MPS ComfyUI', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    onDevice('mps')
    const wf = await buildDynamicWorkflow({ ...params, inputImage: 'start.png' })
    expect(node(wf, 'CFGGuider').inputs.cfg).toBe(1)
  })
  it('keeps the user cfg for image-to-video on CUDA', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    onDevice('cuda')
    const wf = await buildDynamicWorkflow({ ...params, inputImage: 'start.png' })
    expect(node(wf, 'CFGGuider').inputs.cfg).toBe(3)
  })
  it('keeps the user cfg for text-to-video on MPS', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo() as never)
    onDevice('mps')
    const wf = await buildDynamicWorkflow(params)
    expect(node(wf, 'CFGGuider').inputs.cfg).toBe(3)
  })
})

describe('LTX-2 checkpoint install (Lightricks file in models/checkpoints)', () => {
  it('takes MODEL and VAE from the checkpoint, the audio VAE and text projection through the LTX loaders', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(objectInfo({ ckpts: [CKPT], vaes: [] }) as never)
    const wf = await buildDynamicWorkflow({ ...params, model: CKPT })
    expect(validationErrors(wf)).toEqual([])
    const ckptId = Object.entries(wf).find(([, n]) => n.class_type === 'CheckpointLoaderSimple')![0]
    expect(node(wf, 'VAEDecodeTiled').inputs.vae).toEqual([ckptId, 2])
    expect(node(wf, 'LTXVAudioVAELoader').inputs.ckpt_name).toBe(CKPT)
    expect(node(wf, 'LTXAVTextEncoderLoader').inputs).toMatchObject({ text_encoder: GEMMA, ckpt_name: CKPT })
  })
})
