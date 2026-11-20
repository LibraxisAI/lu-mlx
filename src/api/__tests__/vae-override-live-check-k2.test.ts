/**
 * K2 (a user, Discord "HELP WITH MODELS"/help-18,
 * and GH #128-adjacent reports after the 3.0 update): "Prompt outputs failed
 * validation | Node 3 (VAELoader): Value not in list" on Lipsync/Animate.
 *
 * A `params.vae` override (a stale remembered pick from an older LU/ComfyUI
 * install, a wrong path separator, a subfolder-qualified name, ...) used to
 * go straight into the VAELoader node unchecked. buildDynamicWorkflow now
 * validates it against `models.vaes`, the live VAELoader enum already read
 * off the same /object_info response this build used for strategy detection,
 * BEFORE writing the node, and throws an actionable WorkflowUnavailableError
 * instead of letting ComfyUI's opaque "Value not in list" reach the user.
 *
 * review-create.md nachbessert, Punkt 3: a plain `models.vaes.includes()`
 * blocked a file that really IS installed whenever the remembered spelling
 * differed cosmetically (backslash instead of slash, a leftover subfolder
 * prefix, different case) from the live enum's own spelling. The check now
 * normalizes first (normalizeLoaderValue in dynamic-workflow.ts) and, on a
 * match, writes the LIVE enum's spelling to the node, not the remembered
 * one, so an existing file never blocks the run. Only a genuine miss throws.
 *
 * Run: npx vitest run src/api/__tests__/vae-override-live-check-k2.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classTypes, nodeOf } from './graph-test-support'

// Minimal live /object_info for an SDXL-checkpoint ComfyUI. The VAELoader
// enum below is the "installed VAEs" live list K2's fix checks against.
const CHECKPOINT_NODES: Record<string, unknown> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
  VAELoader: { input: { required: { vae_name: [['sdxl_vae.safetensors', 'ae.safetensors']] } } },
  CLIPTextEncode: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}

const baseParams = {
  model: 'sdxl.safetensors',
  prompt: 'a red jacket', negativePrompt: '',
  sampler: 'euler', scheduler: 'normal',
  width: 1024, height: 1024, steps: 20, cfgScale: 7, seed: 1, batchSize: 1,
} as never

describe('buildDynamicWorkflow (K2): VAE override validated against the live list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAllNodeInfo).mockResolvedValue(CHECKPOINT_NODES as never)
  })

  it('a stale/unknown VAE override throws an actionable error naming what IS installed, instead of reaching /prompt', async () => {
    await expect(
      buildDynamicWorkflow({ ...(baseParams as object), vae: 'old-2.6.9-remembered-vae.safetensors' } as never),
    ).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(
      buildDynamicWorkflow({ ...(baseParams as object), vae: 'old-2.6.9-remembered-vae.safetensors' } as never),
    ).rejects.toThrow(/not installed in ComfyUI.*sdxl_vae\.safetensors/s)
  })

  it('a VAE override that really is in the live list builds a valid VAELoader node', async () => {
    const wf = await buildDynamicWorkflow({ ...(baseParams as object), vae: 'ae.safetensors' } as never)
    expect(classTypes(wf)).toContain('VAELoader')
    const [, vaeNode] = nodeOf(wf, 'VAELoader') ?? []
    expect((vaeNode?.inputs as { vae_name?: string } | undefined)?.vae_name).toBe('ae.safetensors')
  })

  // Punkt 3: an existing file must never block the run over a cosmetic
  // mismatch, and the node must carry the LIVE spelling, not the remembered
  // (possibly wrong-case, wrong-separator, subfolder-qualified) one.
  it('a Windows-style backslash path resolves to the live basename, not a rejection', async () => {
    const wf = await buildDynamicWorkflow({ ...(baseParams as object), vae: 'vae\\ae.safetensors' } as never)
    expect(classTypes(wf)).toContain('VAELoader')
    const [, vaeNode] = nodeOf(wf, 'VAELoader') ?? []
    expect((vaeNode?.inputs as { vae_name?: string } | undefined)?.vae_name).toBe('ae.safetensors')
  })

  it('different case resolves to the live spelling', async () => {
    const wf = await buildDynamicWorkflow({ ...(baseParams as object), vae: 'AE.SAFETENSORS' } as never)
    const [, vaeNode] = nodeOf(wf, 'VAELoader') ?? []
    expect((vaeNode?.inputs as { vae_name?: string } | undefined)?.vae_name).toBe('ae.safetensors')
  })

  it('a subfolder-qualified name resolves by basename to the live spelling', async () => {
    const wf = await buildDynamicWorkflow({ ...(baseParams as object), vae: 'vae/sdxl_vae.safetensors' } as never)
    const [, vaeNode] = nodeOf(wf, 'VAELoader') ?? []
    expect((vaeNode?.inputs as { vae_name?: string } | undefined)?.vae_name).toBe('sdxl_vae.safetensors')
  })

  it('a genuinely different, short live-list name is never a false positive for an unrelated stale pick', async () => {
    // Regression guard: "ae.safetensors" is a substring of almost anything
    // ending in those two letters. Normalization must not treat that as a match.
    await expect(
      buildDynamicWorkflow({ ...(baseParams as object), vae: 'old-2.6.9-remembered-vae.safetensors' } as never),
    ).rejects.toThrow(/not installed in ComfyUI/)
  })

  it('"auto" and unset skip the check entirely (checkpoint keeps its bundled VAE)', async () => {
    const wfAuto = await buildDynamicWorkflow({ ...(baseParams as object), vae: 'auto' } as never)
    expect(classTypes(wfAuto)).not.toContain('VAELoader')
    const wfUnset = await buildDynamicWorkflow({ ...(baseParams as object) } as never)
    expect(classTypes(wfUnset)).not.toContain('VAELoader')
  })
})
