/**
 * 3.0.4 Gegenprobe on the Windows box (02.10.2026): sd_turbo started at the SD
 * family's 25 steps. Distilled checkpoints run at a few steps and CFG 1.
 *
 * Run: npx vitest run src/stores/__tests__/a-turbo-checkpoint-starts-at-four-steps.test.ts
 */
import { describe, it, expect } from 'vitest'
import { useCreateStore, distilledImageCheckpoint, MODEL_TYPE_DEFAULTS } from '../createStore'

describe('distilled image checkpoints', () => {
  it('Turbo, Lightning, Hyper and LCM files of the SD families are recognised', () => {
    for (const n of ['sd_turbo.safetensors', 'sdxl_turbo_1.0_fp16.safetensors', 'juggernautXL_v9Rdphoto2Lightning.safetensors', 'Hyper-SDXL-8steps.safetensors', 'dreamshaper_8_LCM.safetensors']) {
      expect(distilledImageCheckpoint(n, 'sdxl')).toBe(true)
    }
  })

  it('leaves ordinary checkpoints and other families alone', () => {
    expect(distilledImageCheckpoint('juggernautXL_v9.safetensors', 'sdxl')).toBe(false)
    expect(distilledImageCheckpoint('turbovision_xl.safetensors', 'sdxl')).toBe(false)
    expect(distilledImageCheckpoint('z_image_turbo_bf16.safetensors', 'zimage')).toBe(false)
  })

  it('picking sd_turbo sets 4 steps at CFG 1, a plain checkpoint keeps the family defaults', () => {
    useCreateStore.getState().setImageModel('sd_turbo.safetensors', 'sd15')
    expect(useCreateStore.getState()).toMatchObject({ steps: 4, cfgScale: 1 })
    useCreateStore.getState().setImageModel('juggernautXL_v9.safetensors', 'sdxl')
    expect(useCreateStore.getState()).toMatchObject({ steps: MODEL_TYPE_DEFAULTS.sdxl.steps, cfgScale: MODEL_TYPE_DEFAULTS.sdxl.cfgScale })
  })

  it('back from a MiniMax H3 video, Image gives sd_turbo its own values again (Gegenprobe 9)', () => {
    const st = useCreateStore.getState()
    st.setImageModel('sd_turbo.safetensors', 'sd15')
    useCreateStore.setState({ videoModel: 'MiniMax-H3-test.safetensors' })
    st.setIntent('video')
    expect(useCreateStore.getState()).toMatchObject({ mode: 'video', sampler: 'res_multistep', width: 1344, height: 768 })
    for (const intent of ['image', 'edit', 'removebg', 'upscale', 'eraser', 'character'] as const) {
      useCreateStore.getState().setIntent('video')
      useCreateStore.getState().setIntent(intent)
      expect(useCreateStore.getState(), intent).toMatchObject({
        mode: 'image', steps: 4, cfgScale: 1,
        sampler: MODEL_TYPE_DEFAULTS.sd15.sampler, scheduler: MODEL_TYPE_DEFAULTS.sd15.scheduler,
        width: 512, height: 512,
      })
    }
  })

  it('inside the image lane a switch keeps what the user tuned', () => {
    const st = useCreateStore.getState()
    st.setIntent('image')
    st.setImageModel('sd_turbo.safetensors', 'sd15')
    useCreateStore.setState({ steps: 9, width: 640 })
    st.setIntent('edit')
    expect(useCreateStore.getState()).toMatchObject({ steps: 9, width: 640 })
  })
})
