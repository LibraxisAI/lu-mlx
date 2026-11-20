/**
 * Discord 2026-09-29 (MiniMax H3) and 2026-10-01
 * (qwen_image_2.1): "CheckpointLoaderSimple: Value not in list".
 * When a family's builder could not find a file, Create fell back to the old
 * fixed graph, which loads every non-FLUX model as an SDXL checkpoint. The
 * missing file now reaches Create as its own sentence and download, and the
 * old graph is only tried for the families it was written for.
 *
 * Run: npx vitest run src/api/__tests__/a-missing-part-is-named-not-sent-to-the-checkpoint-loader.test.ts
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

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { legacyBuilderFits } from '../comfyui'
import { localFetch } from '../backend'

const FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'

const H3_NODES: Record<string, unknown> = {
  UNETLoader: { input: { required: { unet_name: [[FL2VA]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VIDEO_VAE]] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['juggernautXL.safetensors']] } } },
  MiniMaxH3ImageToVideo: { input: { required: {} } },
  MiniMaxH3ReferenceToVideo: { input: { required: {} } },
  BasicGuider: { input: { required: {} } },
  BasicScheduler: { input: { required: {} } },
  KSamplerSelect: { input: { required: {} } },
  RandomNoise: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  VAEDecodeAudio: { input: { required: {} } },
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

const run = {
  model: FL2VA, prompt: 'rain on a tin roof', negativePrompt: '',
  sampler: 'res_multistep', scheduler: 'simple', steps: 20, cfgScale: 1,
  width: 1344, height: 768, seed: 7, batchSize: 1, frames: 124, fps: 24,
} as never

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(H3_NODES as never)
})

describe('a wrapper family with a missing file', () => {
  it('MiniMax H3 without its audio VAE says so and offers that one file', async () => {
    serveEnums([VIDEO_VAE], [ENCODER])
    const err = await buildDynamicWorkflow(run, 'minimaxh3').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toContain(AUDIO_VAE)
    expect(err.missing.map((m: { downloadFilename: string }) => m.downloadFilename)).toEqual([AUDIO_VAE])
    expect(err.missing[0].downloadUrl).toMatch(/Comfy-Org\/MiniMax-H3\/resolve\/main\/vae\//)
  })

  it('MiniMax H3 without its 32B encoder offers the encoder', async () => {
    serveEnums([VIDEO_VAE, AUDIO_VAE], [])
    const err = await buildDynamicWorkflow(run, 'minimaxh3').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.missing.map((m: { downloadFilename: string }) => m.downloadFilename)).toEqual([ENCODER])
  })

  // Negative control: with every file there, the same build goes through.
  it('with every file present the graph is built', async () => {
    serveEnums([VIDEO_VAE, AUDIO_VAE], [ENCODER])
    const wf = await buildDynamicWorkflow(run, 'minimaxh3')
    expect(Object.values(wf).some((n) => n.class_type === 'CheckpointLoaderSimple')).toBe(false)
  })
})

describe('the old fixed graphs', () => {
  it('stay for the families they were written for', () => {
    for (const t of ['sd15', 'sdxl', 'flux', 'flux2', 'unknown'] as const) expect(legacyBuilderFits(t, false)).toBe(true)
    for (const t of ['wan', 'animatediff'] as const) expect(legacyBuilderFits(t, true)).toBe(true)
  })

  it('never take Qwen-Image, MiniMax H3 or the other UNET families', () => {
    for (const t of ['qwenimage', 'qwenimage1', 'zimage', 'krea2', 'chroma', 'hidream', 'sd3', 'lumina2', 'ernie_image'] as const) {
      expect(legacyBuilderFits(t, false)).toBe(false)
    }
    for (const t of ['minimaxh3', 'wan22', 'hunyuan', 'ltx', 'framepack', 'svd'] as const) {
      expect(legacyBuilderFits(t, true)).toBe(false)
    }
  })
})
