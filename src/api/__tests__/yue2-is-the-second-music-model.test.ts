/**
 * YuE2 (m-a-p, ComfyUI nodes since 0.36.0) as the second local music model
 * next to ACE Step. Songs with vocals from a style and lyrics. The graph is the
 * official Comfy-Org template audio_yue2_text2music with ABC planning off
 * (workflow_templates and comfy_extras/nodes_yue2.py, read 2026-10-02).
 *
 * Run: npx vitest run src/api/__tests__/yue2-is-the-second-music-model.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildMusicWorkflow, WorkflowUnavailableError, YUE2_NEEDS_UPDATE, type LocalOpParams } from '../dynamic-workflow'
import {
  classifyModel, getAudioModels, getImageModels, isImageModelType, isVideoModelType, MODEL_TYPE_DEFAULTS,
} from '../comfyui'
import { getAudioBundles } from '../discover'
import { localFetch } from '../backend'
import { nodeOf } from './graph-test-support'

const YUE = 'yue2_3b_int8_convrot.safetensors'
const ACE = 'ace_step_1.5_turbo_aio.safetensors'

const NODES: Record<string, object> = Object.fromEntries([
  'YuE2GenerateMusic', 'EmptyYuE2LatentAudio', 'ConditioningZeroOut', 'KSampler', 'VAEDecodeAudio', 'SaveAudioMP3',
  'TextEncodeAceStepAudio1.5', 'EmptyAceStep1.5LatentAudio', 'ModelSamplingSD3',
].map((n) => [n, {}]))

const params = (extra: Partial<LocalOpParams> = {}): LocalOpParams => ({
  op: 'music', model: YUE, prompt: 'warm indie pop, female vocals, bright guitars', seed: 7, steps: 50, cfgScale: 5,
  sampler: 'euler', scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1, seconds: 90,
  lyrics: '[Verse]\nMorning light across the window\n[Chorus]\nRun with me into the sunlight', ...extra,
})

describe('YuE2 is a music model', () => {
  it('the checkpoint classifies as yue2: not an image, not a video model, not ACE', () => {
    for (const name of [YUE, 'yue2_3b_bf16.safetensors', 'YuE-2-3B.safetensors']) {
      expect(classifyModel(name), name).toBe('yue2')
    }
    expect(classifyModel(ACE)).toBe('ace')
    expect(isImageModelType('yue2')).toBe(false)
    expect(isVideoModelType('yue2')).toBe(false)
    expect(MODEL_TYPE_DEFAULTS.yue2.steps).toBe(32)
  })

  it('the music picker lists YuE2 next to ACE, the image picker lists neither', async () => {
    const checkpoints = [ACE, YUE, 'juggernautXL_v9.safetensors']
    vi.mocked(localFetch).mockImplementation(async (url: string) => {
      const body = String(url).includes('CheckpointLoaderSimple')
        ? { CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } }
        : {}
      return { ok: true, status: 200, json: async () => body } as never
    })
    const audio = await getAudioModels()
    expect(audio.map((m) => [m.name, m.type])).toEqual([[ACE, 'ace'], [YUE, 'yue2']])
    const images = (await getImageModels().catch(() => [])).map((m) => m.name)
    expect(images).not.toContain(YUE)
    expect(images).not.toContain(ACE)
  })
})

describe('the Model Manager card', () => {
  const bundle = () => getAudioBundles().find((b) => b.workflow === 'yue2')!

  it('one all in one checkpoint from Comfy-Org/YuE2, with the sha256 Hugging Face states', () => {
    expect(bundle().files).toHaveLength(1)
    const f = bundle().files[0]
    expect(f.downloadUrl).toBe(`https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/${YUE}`)
    expect(f.filename).toBe(YUE)
    expect(f.subfolder).toBe('checkpoints')
    expect(f.sizeGB).toBeCloseTo(3960938800 / 1_073_741_824, 2)
    expect(f.sha256).toBe('96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6')
    expect(bundle().totalSizeGB).toBeCloseTo(f.sizeGB!, 1)
  })

  it('says it is non-commercial, best tier, and does not take the starter slot from ACE Step 1.5', () => {
    expect(bundle().description).toMatch(/Non-commercial/)
    expect(bundle().tier).toBe('best')
    expect(getAudioBundles()[0].workflow).toBe('ace')
  })
})

describe('the graph follows the official template', () => {
  it('checkpoint, YuE2GenerateMusic (style, lyrics, no ABC), zeroed negative, latent of the made length, KSampler, audio decode', () => {
    const wf = buildMusicWorkflow(params(), 7, NODES)
    const [ckptId, ckpt] = nodeOf(wf, 'CheckpointLoaderSimple')!
    expect(ckpt.inputs.ckpt_name).toBe(YUE)

    const [musicId, music] = nodeOf(wf, 'YuE2GenerateMusic')!
    expect(music.inputs).toMatchObject({
      clip: [ckptId, 1], style: 'warm indie pop, female vocals, bright guitars', abc: '', seed: 7, mode: 'full',
      max_duration: 90, temperature: 1, top_p: 0.95, top_k: 100, repetition_penalty: 1.2,
    })
    expect(String(music.inputs.lyrics)).toMatch(/Morning light/)

    const [zeroId, zero] = nodeOf(wf, 'ConditioningZeroOut')!
    expect(zero.inputs.conditioning).toEqual([musicId, 0])
    const [latentId, latent] = nodeOf(wf, 'EmptyYuE2LatentAudio')!
    expect(latent.inputs).toEqual({ seconds: [musicId, 1], batch_size: 1 })

    const sampler = nodeOf(wf, 'KSampler')![1].inputs
    expect(sampler).toMatchObject({
      model: [ckptId, 0], positive: [musicId, 0], negative: [zeroId, 0], latent_image: [latentId, 0],
      steps: 32, cfg: 1, sampler_name: 'dpm_2', scheduler: 'sgm_uniform', denoise: 1,
    })

    const [decodeId, decode] = nodeOf(wf, 'VAEDecodeAudio')!
    expect(decode.inputs).toEqual({ samples: [nodeOf(wf, 'KSampler')![0], 0], vae: [ckptId, 2] })
    expect(nodeOf(wf, 'SaveAudioMP3')![1].inputs.audio).toEqual([decodeId, 0])
  })

  it('the music sliders do not leak in: ACE steps and cfg are ignored, no ACE encoder is used', () => {
    const wf = buildMusicWorkflow(params({ steps: 77, cfgScale: 9 }), 7, NODES)
    expect(nodeOf(wf, 'KSampler')![1].inputs).toMatchObject({ steps: 32, cfg: 1 })
    expect(nodeOf(wf, 'TextEncodeAceStepAudio1.5')).toBeUndefined()
    expect(nodeOf(wf, 'ModelSamplingSD3')).toBeUndefined()
  })

  it('no lyrics means an empty lyrics input, the length is clamped', () => {
    const wf = buildMusicWorkflow(params({ lyrics: '', seconds: 9999 }), 7, NODES)
    expect(nodeOf(wf, 'YuE2GenerateMusic')![1].inputs).toMatchObject({ lyrics: '', max_duration: 600 })
  })

  it('ACE Step still builds its own graph, with the same nodes available', () => {
    const wf = buildMusicWorkflow(params({ model: ACE }), 7, NODES)
    expect(nodeOf(wf, 'TextEncodeAceStepAudio1.5')).toBeDefined()
    expect(nodeOf(wf, 'YuE2GenerateMusic')).toBeUndefined()
  })
})

describe('the version lock is per model', () => {
  it('without the YuE2 nodes (older than 0.36.0) the update sentence, and ACE Step is not held to it', () => {
    const old = { ...NODES }
    delete old.YuE2GenerateMusic
    delete old.EmptyYuE2LatentAudio
    expect(YUE2_NEEDS_UPDATE).toBe('YuE2 needs ComfyUI 0.36.0 or newer. Update ComfyUI in Settings.')
    let caught: unknown
    try { buildMusicWorkflow(params(), 7, old) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(WorkflowUnavailableError)
    expect((caught as WorkflowUnavailableError).message).toBe(YUE2_NEEDS_UPDATE)
    expect((caught as WorkflowUnavailableError).needsComfyUpdate).toBe(true)
    expect(() => buildMusicWorkflow(params({ model: ACE }), 7, old)).not.toThrow()
  })

  // The box, 03.10.2026: "Update ComfyUI" in the sentence is not what Create
  // asks on, the flag is. A lane whose core nodes are missing is a ComfyUI
  // that is too old, so it carries the flag like a model with a known release.
  it('a ComfyUI without the core nodes of a lane is offered the update too', () => {
    const old = { ...NODES }
    delete old['TextEncodeAceStepAudio1.5']
    let caught: unknown
    try { buildMusicWorkflow(params({ model: ACE }), 7, old) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(WorkflowUnavailableError)
    expect((caught as WorkflowUnavailableError).message).toContain('Update ComfyUI')
    expect((caught as WorkflowUnavailableError).needsComfyUpdate).toBe(true)
  })
})

beforeEach(() => { vi.mocked(localFetch).mockReset() })
