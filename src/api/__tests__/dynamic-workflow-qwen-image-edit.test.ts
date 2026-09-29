/**
 * Qwen-Image-Edit is a diffusion UNET. ComfyUI 0.33 lists
 * qwen_image_edit_2511_fp8mixed.safetensors on UNETLoader, not on
 * CheckpointLoaderSimple. Sending it as ckpt_name is the
 * "Value not in list" rejection on the Image tab.
 *
 * The graph below uses only nodes that object_info on that instance
 * actually has: UNETLoader, CLIPLoader (type qwen_image), VAELoader,
 * TextEncodeQwenImageEditPlus, ModelSamplingAuraFlow, EmptySD3LatentImage,
 * KSampler, VAEDecode, SaveImage, and LoadImage when a still is attached.
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-qwen-image-edit.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return { ...actual, findMatchingCLIP: vi.fn(), findMatchingVAE: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { findMatchingCLIP, findMatchingVAE, classifyModel } from '../comfyui'
import { classTypes, nodeOf } from './graph-test-support'

const QWEN = 'qwen_image_edit_2511_fp8mixed.safetensors'

const QWEN_NODES = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors']] } } },
  UNETLoader: { input: { required: { unet_name: [[QWEN]], weight_dtype: [['default']] } } },
  CLIPLoader: { input: { required: { clip_name: [['qwen_2.5_vl_7b_fp8_scaled.safetensors']], type: [['qwen_image']] } } },
  VAELoader: { input: { required: { vae_name: [['qwen_image_vae.safetensors']] } } },
  TextEncodeQwenImageEditPlus: { input: { required: { clip: ['CLIP'], prompt: ['STRING'] }, optional: { vae: ['VAE'], image1: ['IMAGE'] } } },
  ModelSamplingAuraFlow: { input: { required: { model: ['MODEL'], shift: ['FLOAT'] } } },
  EmptySD3LatentImage: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
  LoadImage: { input: { required: { image: [[]] } } },
  CLIPTextEncode: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
}

const base = {
  prompt: 'a lighthouse',
  negativePrompt: 'blur',
  sampler: 'euler',
  scheduler: 'simple',
  width: 1024,
  height: 1024,
  steps: 20,
  cfgScale: 4,
  cfg: 4,
  seed: 1,
  batchSize: 1,
} as const

const ALLOWED = new Set([
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'TextEncodeQwenImageEditPlus',
  'TextEncodeQwenImageEdit',
  'ModelSamplingAuraFlow',
  'EmptySD3LatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
  'LoadImage',
])

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(QWEN_NODES as never)
  vi.mocked(findMatchingCLIP).mockResolvedValue('qwen_2.5_vl_7b_fp8_scaled.safetensors')
  vi.mocked(findMatchingVAE).mockResolvedValue('qwen_image_vae.safetensors')
})

describe('Qwen Image Edit is not a checkpoint', () => {
  it('classifies the 2511 file as qwen_image_edit', () => {
    expect(classifyModel(QWEN)).toBe('qwen_image_edit')
  })

  it('never emits the Qwen file as CheckpointLoaderSimple.ckpt_name', async () => {
    const wf = await buildDynamicWorkflow({ ...base, model: QWEN } as never)
    expect(nodeOf(wf, 'CheckpointLoaderSimple')).toBeUndefined()
    const unet = nodeOf(wf, 'UNETLoader')
    expect(unet?.[1].inputs.unet_name).toBe(QWEN)
    for (const klass of classTypes(wf)) expect(ALLOWED.has(klass)).toBe(true)
    const clip = nodeOf(wf, 'CLIPLoader')
    expect(clip?.[1].inputs.type).toBe('qwen_image')
    expect(clip?.[1].inputs.clip_name).toBe('qwen_2.5_vl_7b_fp8_scaled.safetensors')
    expect(nodeOf(wf, 'VAELoader')?.[1].inputs.vae_name).toBe('qwen_image_vae.safetensors')
    expect(nodeOf(wf, 'TextEncodeQwenImageEditPlus')).toBeDefined()
    expect(nodeOf(wf, 'ModelSamplingAuraFlow')?.[1].inputs.shift).toBe(3.1)
    expect(nodeOf(wf, 'EmptySD3LatentImage')).toBeDefined()
  })

  it('attaches a source still to the edit encoder, not to a checkpoint graph', async () => {
    const wf = await buildDynamicWorkflow({ ...base, model: QWEN, inputImage: 'src.png', denoise: 0.7 } as never)
    expect(nodeOf(wf, 'CheckpointLoaderSimple')).toBeUndefined()
    expect(nodeOf(wf, 'VAEEncode')).toBeUndefined()
    const encoders = classTypes(wf).filter((k) => k === 'TextEncodeQwenImageEditPlus')
    expect(encoders.length).toBeGreaterThan(0)
    const withImage = Object.values(wf).find((n) => n.class_type === 'TextEncodeQwenImageEditPlus' && n.inputs?.image1)
    expect(withImage).toBeDefined()
    expect(nodeOf(wf, 'LoadImage')?.[1].inputs.image).toBe('src.png')
  })

  it('refuses a filename that is not in the checkpoint list', async () => {
    await expect(buildDynamicWorkflow({
      ...base,
      model: 'not_a_real_checkpoint.safetensors',
    } as never)).rejects.toBeInstanceOf(WorkflowUnavailableError)
  })

  it('still builds the SD graph for a real checkpoint', async () => {
    const wf = await buildDynamicWorkflow({
      ...base,
      model: 'sd_xl_base_1.0.safetensors',
    } as never)
    expect(nodeOf(wf, 'CheckpointLoaderSimple')?.[1].inputs.ckpt_name).toBe('sd_xl_base_1.0.safetensors')
    expect(nodeOf(wf, 'EmptyLatentImage')).toBeDefined()
    expect(nodeOf(wf, 'CLIPTextEncode')).toBeDefined()
  })
})
