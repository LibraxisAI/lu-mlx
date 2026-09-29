/**
 * The checkpoint check must not refuse a model the picker already shows.
 *
 * `getAllNodeInfo()` is cached for 5 minutes, while the model picker reads
 * ComfyUI's checkpoint enum live. A checkpoint downloaded inside that window
 * was in the picker, but the cached list did not have it, so Create answered
 * "not in ComfyUI's checkpoint list" for a file ComfyUI would have loaded.
 * A miss now asks ComfyUI once more (forceRefresh) before refusing.
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-fresh-checkpoint.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { nodeOf } from './graph-test-support'

const nodesWith = (checkpoints: string[]): Record<string, unknown> => ({
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } },
  CLIPTextEncode: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
})

const txt2img = {
  prompt: 'a lighthouse at dusk',
  negativePrompt: '',
  sampler: 'euler',
  scheduler: 'normal',
  width: 1024,
  height: 1024,
  steps: 20,
  cfgScale: 7,
  seed: 1,
  batchSize: 1,
} as const

const STALE = nodesWith(['sdxl.safetensors'])
const FRESH = nodesWith(['sdxl.safetensors', 'just-downloaded.safetensors'])

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockReset()
  vi.mocked(getAllNodeInfo).mockImplementation(async (force?: boolean) =>
    (force ? FRESH : STALE) as never,
  )
})

describe('checkpoint check against a stale node-info cache', () => {
  it('builds the graph for a checkpoint that only the fresh list has', async () => {
    const wf = await buildDynamicWorkflow({ ...txt2img, model: 'just-downloaded.safetensors' } as never)
    const [, ckpt] = nodeOf(wf, 'CheckpointLoaderSimple')!
    expect(ckpt.inputs.ckpt_name).toBe('just-downloaded.safetensors')
    expect(vi.mocked(getAllNodeInfo)).toHaveBeenCalledWith(true)
  })

  it('does not refetch when the cached list already has the model', async () => {
    await buildDynamicWorkflow({ ...txt2img, model: 'sdxl.safetensors' } as never)
    expect(vi.mocked(getAllNodeInfo)).not.toHaveBeenCalledWith(true)
  })

  it('still refuses a checkpoint that ComfyUI really does not list', async () => {
    await expect(
      buildDynamicWorkflow({ ...txt2img, model: 'missing.safetensors' } as never),
    ).rejects.toBeInstanceOf(WorkflowUnavailableError)
  })
})
