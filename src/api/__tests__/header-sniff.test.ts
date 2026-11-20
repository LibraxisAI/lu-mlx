/**
 * The model lists take the family from the file header when the name cannot
 * say it (Discord 2026-09-28), drop stray VAE / text encoder files, and keep
 * the name-based answer whenever the header is not readable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backend = vi.hoisted(() => ({ call: vi.fn(), tauri: vi.fn(() => true) }))
vi.mock('../backend', async (o) => ({ ...(await o<typeof import('../backend')>()), backendCall: backend.call, isTauri: backend.tauri }))

import { applyHeaderSniff, classifyModel, type ClassifiedModel } from '../comfyui'

const list = (): ClassifiedModel[] => [
  { name: 'kr2_realism.safetensors', type: classifyModel('kr2_realism.safetensors'), source: 'diffusion_model' },
  { name: 'myMix_v3.safetensors', type: 'unknown', source: 'checkpoint' },
  { name: 'minimax_h3_video_vae_fp16.safetensors', type: 'unknown', source: 'checkpoint' },
  { name: 'wan2.2_ti2v_5B_fp16.safetensors', type: 'wan22', source: 'diffusion_model' },
  { name: 'pony.gguf', type: 'unknown', source: 'diffusion_model' },
]

beforeEach(() => {
  backend.tauri.mockReturnValue(true)
  backend.call.mockReset().mockImplementation(async (_cmd: string, args: { files: Array<{ folder: string; name: string }> }) =>
    args.files.map((f) => ({
      ...f,
      arch: f.name.startsWith('kr2') ? 'krea2' : f.name.startsWith('myMix') ? 'flux' : f.name.includes('vae') ? 'vae' : null,
      hasTextEncoder: f.name.startsWith('myMix'), hasVae: f.name.startsWith('myMix'),
    })))
})

describe('applyHeaderSniff', () => {
  it('retypes from the header, records the parts, drops a bare VAE', async () => {
    const models = list()
    await applyHeaderSniff(models)
    expect(models.map((m) => [m.name, m.type])).toEqual([
      ['kr2_realism.safetensors', 'krea2'],
      ['myMix_v3.safetensors', 'flux'],
      ['wan2.2_ti2v_5B_fp16.safetensors', 'wan22'],
      ['pony.gguf', 'unknown'],
    ])
    expect(models[1].parts).toEqual({ textEncoder: true, vae: true })
  })

  it('asks only about image-lane names, never a video name or a GGUF, with the right folder', async () => {
    await applyHeaderSniff(list())
    const asked = backend.call.mock.calls[0][1].files
    expect(asked).toEqual([
      { folder: 'diffusion_models', name: 'kr2_realism.safetensors' },
      { folder: 'checkpoints', name: 'myMix_v3.safetensors' },
      { folder: 'checkpoints', name: 'minimax_h3_video_vae_fp16.safetensors' },
    ])
  })

  it('outside the desktop app or on a failing backend the names stand', async () => {
    backend.tauri.mockReturnValue(false)
    const a = list()
    await applyHeaderSniff(a)
    expect(a).toEqual(list())
    backend.tauri.mockReturnValue(true)
    backend.call.mockRejectedValue(new Error('no such command'))
    const b = list()
    await applyHeaderSniff(b)
    expect(b).toEqual(list())
  })
})
