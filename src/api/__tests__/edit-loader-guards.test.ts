/**
 * Discord 2026-09-26..28: Edit came back with
 * "ComfyUI rejected workflow: ... Node 1 (CheckpointLoaderSimple): Value not
 * in list" or "Node 2 (CLIPLoader): Value not in list". The builder picked the
 * loader from the file NAME, so a file LU cannot place that sits in
 * diffusion_models went to CheckpointLoaderSimple, and a family whose text
 * encoder type the local ComfyUI does not have went to CLIPLoader anyway.
 * Both now stop before submit, and Create fixes what it can (see
 * sniffed-families-workflow.test.ts and render-fixups.test.ts).
 *
 * Run: npx vitest run src/api/__tests__/edit-loader-guards.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (o) => ({ ...(await o<typeof import('../comfyui-nodes')>()), getAllNodeInfo: vi.fn() }))
vi.mock('../comfyui', async (o) => ({
  ...(await o<typeof import('../comfyui')>()),
  findMatchingCLIP: vi.fn(async () => 'qwen_3_4b.safetensors'),
  findMatchingVAE: vi.fn(async () => 'ae.safetensors'),
}))

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classifyModel, isStrayAddonFile } from '../comfyui'
import { classTypes } from './graph-test-support'

const nodes = (clipTypes: string[]): Record<string, unknown> => {
  const n: Record<string, unknown> = {}
  for (const k of ['CLIPTextEncode', 'KSampler', 'EmptyLatentImage', 'EmptySD3LatentImage', 'LoadImage', 'VAEEncode', 'VAEDecode', 'SaveImage', 'VAELoader', 'ConditioningZeroOut'])
    n[k] = { input: { required: {} } }
  n.CheckpointLoaderSimple = { input: { required: { ckpt_name: [['juggernautXL_v9.safetensors']] } } }
  n.UNETLoader = { input: { required: { unet_name: [['mystery_merge_v3.safetensors', 'z_image_turbo_bf16.safetensors', 'krea2_fp8.safetensors']] } } }
  n.CLIPLoader = { input: { required: { clip_name: [['qwen_3_4b.safetensors']], type: [clipTypes] } } }
  return n
}
const edit = (model: string) => ({
  model, prompt: 'make the door red', negativePrompt: '', sampler: 'euler', scheduler: 'normal',
  width: 1024, height: 1024, steps: 8, cfgScale: 1, seed: 1, batchSize: 1, inputImage: 'src.png', denoise: 0.7,
}) as never

describe('Edit never submits a loader value ComfyUI does not list', () => {
  beforeEach(() => vi.mocked(getAllNodeInfo).mockResolvedValue(nodes(['stable_diffusion', 'qwen_image', 'krea2']) as never))

  it('a real checkpoint still builds the checkpoint img2img graph', async () => {
    const wf = await buildDynamicWorkflow(edit('juggernautXL_v9.safetensors'), classifyModel('juggernautXL_v9.safetensors'))
    expect(classTypes(wf)).toEqual(expect.arrayContaining(['CheckpointLoaderSimple', 'LoadImage', 'VAEEncode']))
  })

  it('a file neither name nor header can place is refused with a reason, not sent to CheckpointLoaderSimple', async () => {
    const model = 'mystery_merge_v3.safetensors'
    const run = buildDynamicWorkflow(edit(model), classifyModel(model))
    await expect(run).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(run).rejects.toThrow(/does not recognize which model family/)
  })

  it('a file ComfyUI no longer lists is refused with a reason', async () => {
    await expect(buildDynamicWorkflow(edit('gone.safetensors'), 'sdxl')).rejects.toThrow(/no longer in ComfyUI's model list/)
  })

  it('a text encoder type the local ComfyUI lacks asks for a ComfyUI update', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(nodes(['stable_diffusion', 'qwen_image']) as never)
    const run = buildDynamicWorkflow(edit('krea2_fp8.safetensors'), 'krea2')
    await expect(run).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(run).rejects.toThrow(/Update ComfyUI/)
    // ...and says so in a way Create can act on (it offers the update).
    await expect(run).rejects.toMatchObject({ needsComfyUpdate: true })
    // Z-Image's type is there, so it still builds.
    const wf = await buildDynamicWorkflow(edit('z_image_turbo_bf16.safetensors'), 'zimage')
    expect(classTypes(wf)).toEqual(expect.arrayContaining(['UNETLoader', 'CLIPLoader', 'VAEEncode']))
  })
})

describe('stray VAE files stay out of the model picker', () => {
  it.each([
    ['minimax_h3_video_vae_fp16.safetensors', true],
    ['qwen_image_vae.safetensors', true],
    ['sdxl_vae.safetensors', true],
    ['sub\\\\wan_2.1_vae.safetensors', true],
    ['juggernautXL_v9.safetensors', false],
    ['sdxl_bakedvae_model.safetensors', false],
    ['realvisxl_v40_vae.safetensors', false],
    ['ae.safetensors', false],
  ])('%s -> %s', (name, stray) => expect(isStrayAddonFile(name)).toBe(stray))
})
