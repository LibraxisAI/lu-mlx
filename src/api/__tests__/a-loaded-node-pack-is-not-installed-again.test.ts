/**
 * The box, 03.10.2026: a click on Get for "LTX 2.5 · Small (GGUF Q4)" pulled
 * ComfyUI-GGUF again and restarted ComfyUI, with the pack loaded all along
 * (the restart showed in the process start time, nowhere on the surface). A
 * pack whose nodes the running ComfyUI lists is neither installed nor does it
 * cost a restart. One that is not loaded still is.
 *
 * Run: npx vitest run src/api/__tests__/a-loaded-node-pack-is-not-installed-again.test.ts
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import type { ModelBundle } from '../discover'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const localFetch = vi.fn<(url: string, opts?: unknown) => Promise<Response>>()

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  localFetch: (...a: unknown[]) => localFetch(...(a as [string, unknown])),
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  fetchExternal: vi.fn(),
  fetchLocalhostBytes: vi.fn(),
  isTauri: () => true,
}))

import { installBundleComplete, nodePacksNotLoaded, assertBundleFits } from '../discover'
import { clearNodeCache } from '../comfyui-nodes'

let nodes: Record<string, unknown> = {}
let objectInfoAnswers = true

beforeAll(() => {
  ;(globalThis as unknown as { window: EventTarget }).window = new EventTarget()
})

beforeEach(() => {
  clearNodeCache()
  objectInfoAnswers = true
  nodes = { UnetLoaderGGUF: { input: { required: {} }, output: [] } }
  backendCall.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === 'check_model_sizes') return []
    if (cmd === 'check_download_space') return { fits: true }
    if (cmd === 'download_model') return { status: 'started', id: '1' }
    return { status: 'installed' }
  })
  localFetch.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/object_info')) {
      return objectInfoAnswers
        ? new Response(JSON.stringify(nodes), { status: 200 })
        : new Response('down', { status: 503 })
    }
    if (url.endsWith('/system_stats')) return new Response('{}', { status: 503 })
    return new Response('{}', { status: 200 })
  })
})

const bundle = (): ModelBundle => ({
  name: 'LTX 2.5 · Small (GGUF Q4)',
  description: '', tags: [], totalSizeGB: 1, vramRequired: '16 GB',
  customNodes: ['gguf'],
  files: [{
    name: '', description: '', pulls: '', tags: [], updated: '',
    downloadUrl: 'https://example.test/m.gguf', filename: 'm.gguf', subfolder: 'diffusion_models', sizeGB: 1,
  }],
} as unknown as ModelBundle)

const commands = () => backendCall.mock.calls.map((c) => c[0])
/** The node install runs beside the download on purpose; give it its turn. */
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('nodePacksNotLoaded', () => {
  it('leaves out a pack whose nodes ComfyUI lists', async () => {
    expect(await nodePacksNotLoaded(['gguf'])).toEqual([])
  })

  it('keeps a pack that is missing one of its nodes', async () => {
    expect(await nodePacksNotLoaded(['gguf', 'videohelpersuite'])).toEqual(['videohelpersuite'])
  })

  it('counts every pack as missing when ComfyUI does not answer', async () => {
    objectInfoAnswers = false
    expect(await nodePacksNotLoaded(['gguf'])).toEqual(['gguf'])
  })
})

describe('a bundle download', () => {
  it('with its node pack loaded: no install, and ComfyUI is not restarted', async () => {
    await installBundleComplete(bundle())
    await settle()
    expect(commands()).toContain('download_model')
    expect(commands()).not.toContain('install_custom_node')
    expect(commands()).not.toContain('stop_comfyui')
    expect(commands()).not.toContain('start_comfyui')
  })

  it('with its node pack not loaded: installs it and restarts, as before', async () => {
    nodes = {}
    await installBundleComplete(bundle())
    await vi.waitFor(() => expect(commands()).toContain('start_comfyui'))
    expect(commands()).toContain('install_custom_node')
  }, 30_000)
})

// Same click, the other thing it has to settle first: the drive. The check
// asks for the files that are still missing, and a refusal carries Rust's
// sentence with the numbers and stops the install before anything starts.
describe('the space check before a bundle download', () => {
  const two = (): ModelBundle => ({
    ...bundle(),
    files: [
      ...bundle().files,
      { name: '', description: '', pulls: '', tags: [], updated: '', downloadUrl: 'https://example.test/v.safetensors', filename: 'v.safetensors', subfolder: 'vae', sizeGB: 0.5, sizeBytes: 500_000_000 },
    ],
  } as unknown as ModelBundle)
  const spaceCalls = () => backendCall.mock.calls.filter((c) => c[0] === 'check_download_space').map((c) => c[1])

  it('asks for the missing files only, in their exact bytes', async () => {
    await assertBundleFits(two(), new Set(['m.gguf']))
    expect(spaceCalls()).toEqual([{ subfolder: 'vae', destDir: null, requiredBytes: 500_000_000 }])
  })

  it('asks nothing when everything is there', async () => {
    await assertBundleFits(two(), new Set(['m.gguf', 'v.safetensors']))
    expect(spaceCalls()).toEqual([])
  })

  it('a bundle that does not fit starts no download and says how much is short', async () => {
    const SHORT = 'Not enough free space: 0.5 GB short. The download is 27.1 GB, LU keeps 2.0 GB of the drive free, and the drive has 28.6 GB free. Free up some space and start it again.'
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'check_model_sizes') return []
      if (cmd === 'check_download_space') return { fits: false, message: SHORT }
      return { status: 'installed' }
    })
    await expect(installBundleComplete(two())).rejects.toThrow(SHORT)
    expect(commands()).not.toContain('download_model')
    expect(commands()).not.toContain('install_custom_node')
  })
})
