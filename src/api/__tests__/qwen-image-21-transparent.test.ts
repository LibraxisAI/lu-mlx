/**
 * Qwen-Image 2.1 "Transparent background" (02.10.2026): the workflow graph.
 *
 * Read off the real sources, not guessed:
 *   - Comfy-Org/workflow_templates image_qwen_image_2_1_t2i.json, note
 *     "Transparent Image": wrap the prompt, save as PNG to keep alpha.
 *   - ComfyUI 0.38 comfy/sd.py: the 2.1 VAE (4 output channels) makes VAEDecode
 *     return RGBA. nodes.py SaveImage writes the 4 channel array as RGBA PNG.
 * So the graph is the one that already runs; only the prompt changes. These
 * tests build the real graph against a mocked /object_info.
 *
 * Run: npx vitest run src/api/__tests__/qwen-image-21-transparent.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { transparentPrompt } from '../../lib/transparent-image'
import { nodeOf, nodesOf } from './graph-test-support'
import { QWEN21_WEIGHTS } from './qwen21-weights'

const ENCODER = 'qwen3vl_8b_int8_convrot.safetensors'
const VAE_FILE = 'qwen_image_2.1_vae_bf16.safetensors'

const qwenNodes = (model: string) => ({
  UNETLoader: { input: { required: { unet_name: [[model]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } },
  TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } },
  EmptyLatentImage: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
})

const paramsFor = (model: string) => ({
  model,
  prompt: 'a red apple on a white plate', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 25, cfgScale: 1, width: 1024, height: 1024, seed: 42, batchSize: 1,
})

beforeEach(() => {
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
      VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } },
    }),
  } as never)
})

describe.each(QWEN21_WEIGHTS)('Transparent background: the graph, %s', (_weights, MODEL) => {
  const baseParams = paramsFor(MODEL)
  beforeEach(() => { vi.mocked(getAllNodeInfo).mockResolvedValue(qwenNodes(MODEL) as never) })

  it('wraps the prompt the way the official template says', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, transparent: true } as never)
    const enc = nodesOf(wf, 'TextEncodeQwenImage21')
    expect(enc).toHaveLength(1)
    expect(enc[0][1].inputs.prompt).toBe(
      'This is an RGBA format image with transparency. a red apple on a white plate. The image has an alpha channel and a transparent background.',
    )
    expect(enc[0][1].inputs.prompt).toBe(transparentPrompt(baseParams.prompt))
  })

  it('without the switch the prompt goes through untouched', async () => {
    const off = await buildDynamicWorkflow({ ...baseParams } as never)
    const explicit = await buildDynamicWorkflow({ ...baseParams, transparent: false } as never)
    expect(nodeOf(off, 'TextEncodeQwenImage21')![1].inputs.prompt).toBe(baseParams.prompt)
    expect(explicit).toEqual(off)
  })

  it('changes nothing else: the graph is the one that already runs', async () => {
    const plain = await buildDynamicWorkflow({ ...baseParams } as never)
    const alpha = await buildDynamicWorkflow({ ...baseParams, transparent: true } as never)
    const strip = (wf: typeof plain) => JSON.parse(JSON.stringify(wf, (k, v) => (k === 'prompt' && typeof v === 'string' ? '<prompt>' : v)))
    expect(strip(alpha)).toEqual(strip(plain))
  })

  it('decodes with the 2.1 VAE and saves straight from the decode, no node in between that could drop alpha', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, transparent: true } as never)
    const [vaeId] = nodeOf(wf, 'VAELoader')!
    const [decodeId, decode] = nodeOf(wf, 'VAEDecode')!
    expect(decode.inputs.vae).toEqual([vaeId, 0])
    expect(nodeOf(wf, 'VAELoader')![1].inputs.vae_name).toBe(VAE_FILE)
    const saves = nodesOf(wf, 'SaveImage')
    expect(saves).toHaveLength(1)
    expect(saves[0][1].inputs.images).toEqual([decodeId, 0])
    // The classes that would flatten to three channels or re-encode as JPEG.
    const classes = Object.values(wf).map((n) => n.class_type)
    for (const bad of ['ImageScale', 'ImageScaleBy', 'ImageBlend', 'ImageCompositeMasked', 'PreviewImage', 'SaveAnimatedWEBP', 'SaveImageWebsocket']) {
      expect(classes).not.toContain(bad)
    }
  })

  it('keeps the canvas, sampler and negative prompt', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, transparent: true, width: 1536, height: 864 } as never)
    expect(nodeOf(wf, 'EmptyLatentImage')![1].inputs).toMatchObject({ width: 1536, height: 864 })
    expect(nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.negative_prompt).toBe('')
    expect(nodeOf(wf, 'KSampler')![1].inputs.cfg).toBe(1)
  })

  it('an edit takes its picture from the reference: the wrapper stays out of it', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, prompt: 'make the apple green', transparent: true, inputImage: 'lu_source.png', denoise: 0.7 } as never)
    expect(nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.prompt).toBe('make the apple green')
  })

  it('a prompt that already ends in a full stop is not wrapped into a double one', async () => {
    const wf = await buildDynamicWorkflow({ ...baseParams, prompt: 'a red apple.', transparent: true } as never)
    expect(nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.prompt).toContain('transparency. a red apple. The image has')
  })
})
