/**
 * The three Qwen-Image 2.1 bundles share files: the official one and the one
 * without refusals share the image model and the VAE and differ in the text
 * encoder, Noct Q shares the text encoder and the VAE with the official one
 * and differs in the image model. So the card of one must not read Installed
 * on the files of another: the file that differs is what makes each bundle
 * what it is.
 *
 * Run: npx vitest run src/api/__tests__/qwen-image-21-no-refusals-installed.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const onDisk = vi.hoisted(() => ({ files: new Map<string, number>() }))

vi.mock('../backend', () => ({
  backendCall: async (cmd: string, args: { files: { filename: string }[] }) => {
    if (cmd !== 'check_model_sizes') return {}
    return args.files.map((f) => {
      const bytes = onDisk.files.get(f.filename)
      return { filename: f.filename, exists: bytes != null, actualBytes: bytes ?? 0, complete: bytes != null }
    })
  },
  fetchExternal: vi.fn(),
}))
vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  readComfyFolderLists: async () => {
    const names = [...onDisk.files.keys()]
    return {
      diffusion_models: names.filter((n) => n.startsWith('qwen_image_2.1_int8') || n.startsWith('NoctQ')),
      vae: names.filter((n) => n.includes('vae')),
      text_encoders: names.filter((n) => n.startsWith('qwen3vl')),
    }
  },
  filterPartialFiles: async (names: string[]) => new Set(names),
  refreshComfyModels: vi.fn(async () => true),
}))

const { checkBundlesInstalled, getImageBundles } = await import('../discover')

const MODEL = ['qwen_image_2.1_int8_convrot.safetensors', 7_256_783_064] as const
const VAE = ['qwen_image_2.1_vae_bf16.safetensors', 675_509_688] as const
const OFFICIAL = ['qwen3vl_8b_int8_convrot.safetensors', 9_350_798_360] as const
const FREE = ['qwen3vl_8b_int8_convrot_heretic.safetensors', 9_350_828_392] as const
const NOCT = ['NoctQ_V4_int8_convrot.safetensors', 7_256_784_368] as const

const OFFICIAL_BUNDLE = 'Qwen-Image 2.1 (Generate and Edit)'
const FREE_BUNDLE = 'Qwen-Image 2.1 (No Filter)'
const NOCT_BUNDLE = 'Noct Q (Qwen-Image 2.1, Unfiltered)'
const bundles = getImageBundles().filter((b) => [OFFICIAL_BUNDLE, FREE_BUNDLE, NOCT_BUNDLE].includes(b.name))

const have = (...files: (readonly [string, number])[]) => { onDisk.files = new Map(files) }

beforeEach(() => { onDisk.files = new Map() })

describe('Installed, for the three Qwen-Image 2.1 bundles', () => {
  it('only the official files: the official card reads Installed, the other one does not', async () => {
    have(MODEL, VAE, OFFICIAL)
    expect(await checkBundlesInstalled(bundles)).toEqual({ [OFFICIAL_BUNDLE]: true, [FREE_BUNDLE]: false, [NOCT_BUNDLE]: false })
  })

  it('the edition without refusals alone: its card reads Installed, the official one does not', async () => {
    have(MODEL, VAE, FREE)
    expect(await checkBundlesInstalled(bundles)).toEqual({ [OFFICIAL_BUNDLE]: false, [FREE_BUNDLE]: true, [NOCT_BUNDLE]: false })
  })

  it('both encoders next to the shared files: both read Installed', async () => {
    have(MODEL, VAE, OFFICIAL, FREE)
    expect(await checkBundlesInstalled(bundles)).toEqual({ [OFFICIAL_BUNDLE]: true, [FREE_BUNDLE]: true, [NOCT_BUNDLE]: false })
  })

  it('Noct Q with the official text encoder and the VAE: only its card reads Installed', async () => {
    have(NOCT, VAE, OFFICIAL)
    expect(await checkBundlesInstalled(bundles)).toEqual({ [OFFICIAL_BUNDLE]: false, [FREE_BUNDLE]: false, [NOCT_BUNDLE]: true })
  })

  it('Noct Q next to the encoder without refusals only: no card reads Installed', async () => {
    have(NOCT, VAE, FREE)
    expect(await checkBundlesInstalled(bundles)).toEqual({ [OFFICIAL_BUNDLE]: false, [FREE_BUNDLE]: false, [NOCT_BUNDLE]: false })
  })

  it('everything on disk: all three read Installed', async () => {
    have(MODEL, NOCT, VAE, OFFICIAL, FREE)
    expect(await checkBundlesInstalled(bundles)).toEqual({ [OFFICIAL_BUNDLE]: true, [FREE_BUNDLE]: true, [NOCT_BUNDLE]: true })
  })
})
