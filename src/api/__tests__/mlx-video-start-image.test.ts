// @vitest-environment jsdom
/**
 * Which local video model on the Mac starts from an image is the catalogue's
 * word (`acceptsImage` and `requiresImage` from `video_list_models`), and
 * Create's lanes filter by it. The display name must not decide: "MLX LTX-2.3
 * Dev" reads as image to video by the ComfyUI name rule, and that checkpoint
 * fails on a start image in the engine (mlx-video #49).
 *
 * Run: npx vitest run src/api/__tests__/mlx-video-start-image.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, isTauri: () => true, backendCall: (...a: unknown[]) => backendCall(...a) }
})

import { buildMlxVideoModels, generateVideo, mlxTakesStartImage, mlxVideoStartImage, stageStartImage, type VideoModel } from '../mlx-video'
import { canRunVideoLane, videoLaneModels } from '../comfyui'

const entry = (id: string, name: string, family: string, extra: Partial<VideoModel> = {}): VideoModel => ({
  id, name, family, repo: '', sizeGB: 1, sizeBytes: 1e9, minRamGB: 16, defaultFrames: 81,
  fps: 16, defaultWidth: 1280, defaultHeight: 704, negativePrompt: true, userSampling: false,
  needsConvert: false, unfiltered: false, description: '', installed: true, ...extra,
})

const WAN21 = entry('wan21-t2v-1.3b', 'Wan 2.1 T2V 1.3B', 'wan_2')
const TI2V = entry('wan22-ti2v-5b-q8', 'Wan 2.2 TI2V 5B 8-bit', 'wan_2', { acceptsImage: true })
const I2V = entry('wan22-i2v-a14b', 'Wan 2.2 I2V A14B', 'wan_2', { acceptsImage: true, requiresImage: true })
const LTX23 = entry('ltx-2.3-dev', 'LTX-2.3 Dev', 'ltx_2')

beforeEach(() => backendCall.mockReset())

describe('what the catalogue says about a start image', () => {
  it('reads three answers from the two flags, and a model that needs one takes one', () => {
    expect(mlxVideoStartImage(WAN21)).toBe('none')
    expect(mlxVideoStartImage(TI2V)).toBe('optional')
    expect(mlxVideoStartImage(I2V)).toBe('required')
    expect(mlxVideoStartImage({ requiresImage: true })).toBe('required')
  })

  it('carries the answer on every entry of the Create list', () => {
    const list = buildMlxVideoModels([WAN21, TI2V, I2V, LTX23, { ...TI2V, id: 'x', name: 'Not installed', installed: false }])
    expect(list.map((m) => [m.name, m.startImage])).toEqual([
      ['MLX Wan 2.1 T2V 1.3B', 'none'],
      ['MLX Wan 2.2 TI2V 5B 8-bit', 'optional'],
      ['MLX Wan 2.2 I2V A14B', 'required'],
      ['MLX LTX-2.3 Dev', 'none'],
    ])
  })
})

describe('the lanes follow the catalogue, not the name', () => {
  const list = buildMlxVideoModels([WAN21, TI2V, I2V, LTX23])
  const names = (intent: string) => videoLaneModels(list, intent).map((m) => m.name)

  it('Video lists what runs from text: the model that needs an image is not offered there', () => {
    expect(names('video')).toEqual(['MLX Wan 2.1 T2V 1.3B', 'MLX Wan 2.2 TI2V 5B 8-bit', 'MLX LTX-2.3 Dev'])
  })

  it('Animate lists what starts from an image, and LTX-2.3 on mlx-video is not among them', () => {
    expect(names('animate')).toEqual(['MLX Wan 2.2 TI2V 5B 8-bit', 'MLX Wan 2.2 I2V A14B'])
  })

  it('a ComfyUI file carries no word of its own and keeps the name rule', () => {
    const comfy = { name: 'ltx-video-2b-v0.9.safetensors', type: 'ltx', source: 'checkpoint' } as const
    expect(canRunVideoLane(comfy, 'animate')).toBe(true)
    expect(canRunVideoLane({ ...comfy, name: 'svd_xt.safetensors' }, 'video')).toBe(false)
  })

  it('Animate is a local tab on the Mac only while such a model is installed', () => {
    expect(mlxTakesStartImage(buildMlxVideoModels([WAN21, LTX23]))).toBe(false)
    expect(mlxTakesStartImage(buildMlxVideoModels([WAN21, TI2V]))).toBe(true)
    expect(mlxTakesStartImage(buildMlxVideoModels([I2V]))).toBe(true)
    // A ComfyUI list has no say here.
    expect(mlxTakesStartImage([{ }])).toBe(false)
  })
})

describe('stageStartImage', () => {
  it('sends the bytes as plain base64 and answers with the path on disk', async () => {
    backendCall.mockResolvedValue({ path: '/data/videos/start-images/abc.png' })
    const path = await stageStartImage(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    expect(path).toBe('/data/videos/start-images/abc.png')
    expect(backendCall).toHaveBeenCalledWith('video_stage_start_image', { args: { data: 'AQID' } })
  })
})

describe('generateVideo', () => {
  it('names the negative prompt the way Rust reads it, and leaves an empty one out', async () => {
    backendCall.mockResolvedValue({ ok: true, jobId: 'j', pid: 1, output: '/v/out.mp4' })
    await generateVideo({ id: 'wan21-t2v-1.3b', prompt: 'a fox', seconds: 2, negativePrompt: ' blurry ' })
    expect(backendCall).toHaveBeenLastCalledWith('video_generate', { args: expect.objectContaining({ id: 'wan21-t2v-1.3b', negative_prompt: 'blurry' }) })
    await generateVideo({ id: 'wan21-t2v-1.3b', prompt: 'a fox', seconds: 2, negativePrompt: '  ' })
    expect(backendCall.mock.lastCall?.[1].args.negative_prompt).toBeUndefined()
  })
})
