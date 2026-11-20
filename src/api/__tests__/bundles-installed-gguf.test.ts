/**
 * GH #113, second half: the installed check has to know the GGUF loader.
 *
 * checkBundlesInstalled confirms its disk verdict against the running
 * ComfyUI, so a bundle that sits in a folder ComfyUI does not read cannot
 * claim to be installed. It built that visible-set from
 * checkpoints, diffusion_models, vae and text_encoders, and UNETLoader only
 * enumerates .safetensors and .sft. GGUF quants are listed by ComfyUI-GGUF's
 * own loader, which the Create probe learned in b8531b6 and this one did not.
 *
 * Both Unfiltered video bundles are GGUF (NSFW Wan 14B, Wan 2.2 Rapid AIO),
 * which is the "unfiltered models doesn't shown as installed" in the title.
 *
 * Run: npx vitest run src/api/__tests__/bundles-installed-gguf.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const ggufUnets = vi.fn<() => Promise<string[]>>(async () => [])

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  fetchExternal: vi.fn(),
}))

vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  // Every folder the catalog writes into is read back through ONE table now
  // (COMFY_MODEL_FOLDERS), so a fixture says what the engine lists per folder
  // rather than faking a loader at a time. Here the engine has nothing but the
  // quant ComfyUI-GGUF lists: UNETLoader cannot see a .gguf at all, which is
  // the whole of GH #113's second half.
  readComfyFolderLists: async () => ({ diffusion_models: await ggufUnets() }),
  filterPartialFiles: async (names: string[]) => new Set(names),
}))

import { checkBundlesInstalled } from '../discover'
import type { ModelBundle } from '../discover'

const GGUF_BUNDLE = {
  name: 'Wan 2.2 Rapid AIO (Uncensored I2V, GGUF)',
  description: '',
  tags: [],
  totalSizeGB: 16.6,
  vramRequired: '10-12 GB',
  files: [
    {
      name: '', description: '', pulls: '', tags: [], updated: '',
      filename: 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf',
      subfolder: 'diffusion_models', sizeGB: 10.1,
    },
  ],
} as unknown as ModelBundle

describe('a GGUF bundle on disk is confirmed against the loader that lists it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The disk says every file is there at full size.
    backendCall.mockResolvedValue([
      { filename: 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf', exists: true, actualBytes: 1, complete: true },
    ])
  })

  it('counts as installed when ComfyUI-GGUF lists the quant', async () => {
    ggufUnets.mockResolvedValue(['wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'])
    const out = await checkBundlesInstalled([GGUF_BUNDLE])
    expect(out[GGUF_BUNDLE.name]).toBe(true)
  })

  it('NEGATIVE CONTROL: a file no loader lists is still not installed', async () => {
    // Same disk answer, same engine, only the GGUF loader silent as well.
    // This one is green before and after on purpose: it pins that the fix
    // taught the check a fifth list rather than weakening the gate. The
    // A user case, a model folder ComfyUI does not read, must still be
    // caught. The test above is the one that was red before the fix.
    ggufUnets.mockResolvedValue([])
    const out = await checkBundlesInstalled([GGUF_BUNDLE])
    expect(out[GGUF_BUNDLE.name]).toBe(false)
  })

  it('the GGUF loader is asked once, not per bundle', async () => {
    ggufUnets.mockResolvedValue(['wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'])
    await checkBundlesInstalled([GGUF_BUNDLE, { ...GGUF_BUNDLE, name: 'second' } as ModelBundle])
    expect(ggufUnets).toHaveBeenCalledTimes(1)
  })
})
