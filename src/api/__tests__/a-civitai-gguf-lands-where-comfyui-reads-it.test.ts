/**
 * Discord 2026-09-23 (Windows 11, RTX 5060 Ti 16 GB): a CivitAI
 * GGUF, qwenImageEdit2511_q50.gguf, downloaded to "Complete" and the
 * Installed tab stayed at 0. It went to checkpoints/, which no loader reads
 * for .gguf, and the ComfyUI-GGUF pack that reads diffusion_models/ was never
 * installed for it.
 *
 * Run: npx vitest run src/api/__tests__/a-civitai-gguf-lands-where-comfyui-reads-it.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
const fetchExternal = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  fetchExternal: (...args: unknown[]) => fetchExternal(...args),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

let nodes: Record<string, unknown> = {}
vi.mock('../comfyui-nodes', () => ({
  getAllNodeInfo: async () => nodes,
  clearNodeCache: () => {},
}))
vi.mock('../comfy-restart', () => ({ restartComfyForNewNodes: async () => ({ restarted: true }) }))

import { searchCivitaiModels, startCivitaiDownload } from '../discover'

const hit = (fileName: string, itemName: string) => JSON.stringify({
  items: [{
    id: 7, name: itemName, stats: {},
    modelVersions: [{ downloadUrl: 'https://civitai.com/api/download/models/7', files: [{ name: fileName, sizeKB: 1024 }] }],
  }],
})

const calls = (cmd: string) => backendCall.mock.calls.filter((c) => c[0] === cmd)

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'comfy_model_target') return { remote: false }
    if (cmd === 'install_custom_node') return { status: 'installed' }
    return { status: 'started', id: 'x' }
  })
  fetchExternal.mockReset()
  nodes = {}
})

describe('a GGUF from the CivitAI search', () => {
  it('goes to diffusion_models, whatever the model is called', async () => {
    fetchExternal.mockResolvedValue(hit('qwenImageEdit2511_q50.gguf', 'Qwen Image Edit 2511 GGUF'))
    const [m] = await searchCivitaiModels('qwen edit')
    expect(m.subfolder).toBe('diffusion_models')
  })

  it('brings the ComfyUI-GGUF pack along when this ComfyUI lacks it', async () => {
    await startCivitaiDownload({ downloadUrl: 'https://civitai.com/api/download/models/7', filename: 'x.gguf', subfolder: 'diffusion_models' })
    await vi.waitFor(() => expect(calls('install_custom_node')).toHaveLength(1))
    expect(calls('install_custom_node')[0][1]).toMatchObject({ nodeName: 'ComfyUI-GGUF' })
  })

  // Negative controls: an install restarts ComfyUI, so it happens only when needed.
  it('installs nothing when the pack is already there', async () => {
    nodes = { UnetLoaderGGUF: {} }
    await startCivitaiDownload({ downloadUrl: 'https://civitai.com/api/download/models/7', filename: 'x.gguf', subfolder: 'diffusion_models' })
    expect(calls('install_custom_node')).toHaveLength(0)
  })

  it('leaves a safetensors checkpoint where it always went', async () => {
    fetchExternal.mockResolvedValue(hit('juggernautXL.safetensors', 'Juggernaut XL'))
    const [m] = await searchCivitaiModels('juggernaut')
    expect(m.subfolder).toBe('checkpoints')
    await startCivitaiDownload(m)
    expect(calls('install_custom_node')).toHaveLength(0)
  })
})
