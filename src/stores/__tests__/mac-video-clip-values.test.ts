/**
 * The length of a clip in Create follows the catalogue entry of the model
 * the lane runs (persona walk of the Mac app, 09.10.2026, Fund 19).
 *
 * The store set a video model's values from ComfyUI's family table: LTX got
 * 97 frames where its Mac entry says 49, and on Animate, where the lane runs
 * the first model that takes an image and not the stored pick, the 16 fps of
 * the stored Wan stayed under an LTX.
 *
 * Run: npx vitest run src/stores/__tests__/mac-video-clip-values.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../api/mlx-image', () => ({ isMlxImageHost: () => true, MLX_MODEL_PREFIX: 'MLX ' }))

import { useCreateStore } from '../createStore'
import type { ClassifiedModel } from '../../api/comfyui'

const WAN: ClassifiedModel = { name: 'MLX Wan 2.1 T2V 1.3B', type: 'wan', source: 'checkpoint', startImage: 'none', mlxVideo: { frames: 81, fps: 16, frameStep: 4, width: 832, height: 480, negativePrompt: true } }
const LTX: ClassifiedModel = { name: 'MLX LTX-2.3 Distilled 8-bit', type: 'ltx', source: 'checkpoint', startImage: 'optional', mlxVideo: { frames: 49, fps: 24, frameStep: 8, width: 768, height: 512, negativePrompt: false } }
const clip = () => { const s = useCreateStore.getState(); return { frames: s.frames, fps: s.fps } }

describe('on a Mac', () => {
  beforeEach(() => {
    useCreateStore.setState({ backend: 'local', videoModel: '', videoModelList: [], frames: 49, fps: 16 })
    useCreateStore.getState().setIntent('image')
    useCreateStore.getState().setVideoModelList([WAN, LTX])
  })

  it('picking a model sets the frames and the rate of its catalogue entry', () => {
    useCreateStore.getState().setIntent('video')
    useCreateStore.getState().setVideoModel(LTX.name)
    // The family table says 97 frames for LTX.
    expect(clip()).toEqual({ frames: 49, fps: 24 })
    useCreateStore.getState().setVideoModel(WAN.name)
    expect(clip()).toEqual({ frames: 81, fps: 16 })
  })

  it('Animate takes the values of the model the lane runs, not of the stored pick', () => {
    useCreateStore.getState().setVideoModel(WAN.name)
    useCreateStore.getState().setIntent('video')
    expect(clip()).toEqual({ frames: 81, fps: 16 })
    // Wan 2.1 T2V takes no start image, so Animate runs the LTX.
    useCreateStore.getState().setIntent('animate')
    expect(useCreateStore.getState().videoModel).toBe(WAN.name)
    expect(clip()).toEqual({ frames: 49, fps: 24 })
    // And back on Video the stored pick runs again.
    useCreateStore.getState().setIntent('video')
    expect(clip()).toEqual({ frames: 81, fps: 16 })
  })

  it('and the size of its catalogue entry, which is the size the run has', () => {
    // The family table says 832 x 480 for every Wan and 768 x 512 for LTX.
    // The catalogue says it per model, and the gallery entry reads the store.
    const size = () => { const s = useCreateStore.getState(); return [s.width, s.height] }
    const wide: ClassifiedModel = { ...WAN, name: 'MLX Wan 2.2 TI2V 5B', startImage: 'optional', mlxVideo: { ...WAN.mlxVideo!, fps: 24, width: 1280, height: 704 } }
    useCreateStore.getState().setVideoModelList([WAN, LTX, wide])
    useCreateStore.getState().setIntent('video')
    useCreateStore.getState().setVideoModel(wide.name)
    expect(size()).toEqual([1280, 704])
    useCreateStore.getState().setVideoModel(LTX.name)
    expect(size()).toEqual([768, 512])
    useCreateStore.getState().setVideoModel(WAN.name)
    expect(size()).toEqual([832, 480])
  })

  it('a switch of the mode reads the same entry', () => {
    useCreateStore.getState().setVideoModel(LTX.name)
    useCreateStore.setState({ frames: 9, fps: 1 })
    useCreateStore.getState().setMode('video')
    expect(clip()).toEqual({ frames: 49, fps: 24 })
  })
})

describe('COUNTER-CHECK: a ComfyUI list keeps the family table', () => {
  const comfyLtx: ClassifiedModel = { name: 'ltx-video-2b-v0.9.5.safetensors', type: 'ltx', source: 'checkpoint' }
  const comfyWan: ClassifiedModel = { name: 'wan2.1_t2v_1.3B_fp16.safetensors', type: 'wan', source: 'diffusion_model' as ClassifiedModel['source'] }

  beforeEach(() => {
    useCreateStore.setState({ backend: 'local', videoModel: '', videoModelList: [], frames: 1, fps: 1 })
    useCreateStore.getState().setIntent('image')
    useCreateStore.getState().setVideoModelList([comfyWan, comfyLtx])
  })

  it('LTX opens on 97 frames at 24 and Wan on 49 at 16, as before', () => {
    useCreateStore.getState().setIntent('video')
    useCreateStore.getState().setVideoModel(comfyLtx.name)
    expect(clip()).toEqual({ frames: 97, fps: 24 })
    useCreateStore.getState().setVideoModel(comfyWan.name)
    expect(clip()).toEqual({ frames: 49, fps: 16 })
    // The stored pick decides on every tab: no entry here carries `mlxVideo`.
    useCreateStore.getState().setIntent('animate')
    expect(clip()).toEqual({ frames: 49, fps: 16 })
  })
})
