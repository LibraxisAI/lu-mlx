/**
 * An MLX picker id must never be sent as CheckpointLoaderSimple.ckpt_name,
 * and it must never be silently rewritten to the first Comfy checkpoint.
 * "MLX NSFW-gen v2" on the img2img/expand graph was rejected by ComfyUI
 * ("Value not in list"). Expand of that model stays on the MLX lane with
 * the same name. A user-chosen real checkpoint can still build the Comfy
 * expand graph.
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-mlx-checkpoint.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { routeLocalImageRun } from '../mlx-image'
import { nodeOf } from './graph-test-support'

const CHECKPOINT_NODES: Record<string, unknown> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
  CLIPTextEncode: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  LoadImage: { input: { required: { image: [[]] } } },
  VAEEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}

const expand = {
  prompt: 'expand',
  negativePrompt: '',
  sampler: 'euler',
  scheduler: 'normal',
  width: 1024,
  height: 1024,
  steps: 20,
  cfgScale: 7,
  seed: 1,
  batchSize: 1,
  inputImage: 'src.png',
  denoise: 0.7,
} as const

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(CHECKPOINT_NODES as never)
})

describe('MLX ids are not Comfy checkpoints', () => {
  it('refuses to emit ckpt_name for an MLX model', async () => {
    await expect(buildDynamicWorkflow({
      ...expand,
      model: 'MLX NSFW-gen v2',
    } as never)).rejects.toBeInstanceOf(WorkflowUnavailableError)
  })

  it('keeps expand of an MLX model on the MLX lane even when a Comfy checkpoint is present', () => {
    const routed = routeLocalImageRun({
      isMlxHost: true,
      intent: 'edit',
      model: 'MLX NSFW-gen v2',
    })
    expect(routed.lane).toBe('mlx')
    if (routed.lane !== 'mlx') return
    expect(routed.model).toBe('MLX NSFW-gen v2')
    expect(routed.model).not.toBe('sdxl.safetensors')
  })

  it('does not substitute the first Comfy checkpoint when the lane is MLX-only', () => {
    const routed = routeLocalImageRun({
      isMlxHost: true,
      intent: 'edit',
      model: 'MLX NSFW-gen v2',
    })
    expect(routed).toEqual({ lane: 'mlx', model: 'MLX NSFW-gen v2' })
  })

  it('blocks an MLX id on a Comfy-only intent instead of renaming it', () => {
    const routed = routeLocalImageRun({
      isMlxHost: true,
      intent: 'removebg',
      model: 'MLX NSFW-gen v2',
    })
    expect(routed.lane).toBe('blocked')
  })

  it('img2img expand of a real checkpoint still builds the Comfy graph', async () => {
    const routed = routeLocalImageRun({
      isMlxHost: true,
      intent: 'edit',
      model: 'sdxl.safetensors',
    })
    expect(routed).toEqual({ lane: 'comfy', model: 'sdxl.safetensors' })
    if (routed.lane !== 'comfy') return

    const wf = await buildDynamicWorkflow({ ...expand, model: routed.model } as never)
    const [, ckpt] = nodeOf(wf, 'CheckpointLoaderSimple')!
    expect(ckpt.inputs.ckpt_name).toBe('sdxl.safetensors')
    expect(ckpt.inputs.ckpt_name).not.toMatch(/^MLX /)
    const [, save] = nodeOf(wf, 'SaveImage')!
    expect(save.inputs.filename_prefix).toBe('expand')
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.denoise).toBe(0.7)
    expect(Object.values(wf).map((n) => n.class_type)).toEqual(
      expect.arrayContaining(['LoadImage', 'VAEEncode', 'KSampler', 'SaveImage']),
    )
  })
})
