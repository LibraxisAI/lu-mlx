/**
 * Windows box, 05.10.2026 (probe 7): Create, Image, sd_turbo. Picked fresh the
 * model stands at 4 steps and CFG 1 and the Quality control read "Draft". A
 * click on "Draft" then wrote 15 steps (Standard 25, High 38) and left CFG as
 * it was, 5 in that profile, and the image came out overcooked. The buttons
 * measured from the SD family's 25 steps, not from the model that was picked.
 *
 * Run: npx vitest run src/stores/__tests__/quality-measures-from-the-picked-model.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCreateStore, imageQualityLadder, MODEL_TYPE_DEFAULTS, type ImageQuality } from '../createStore'

const ladder = () => imageQualityLadder(useCreateStore.getState())
/** The button the control shows as picked: the nearest step count (Composer). */
const shown = (): ImageQuality => {
  const { steps } = useCreateStore.getState()
  const entries = Object.entries(ladder().steps) as [ImageQuality, number][]
  return entries.reduce((best, entry) => (Math.abs(entry[1] - steps) < Math.abs(best[1] - steps) ? entry : best))[0]
}
const click = (quality: ImageQuality) => useCreateStore.getState().setImageQuality(quality)
const values = () => {
  const { steps, cfgScale } = useCreateStore.getState()
  return { steps, cfgScale }
}

beforeEach(() => {
  useCreateStore.setState({ backend: 'local' })
  useCreateStore.getState().setIntent('image')
})

describe('sd_turbo, a checkpoint distilled to a few steps', () => {
  beforeEach(() => { useCreateStore.getState().setImageModel('sd_turbo.safetensors', 'sd15') })

  it('picked fresh it stands on Standard, which is its own 4 steps at CFG 1', () => {
    expect(values()).toEqual({ steps: 4, cfgScale: 1 })
    expect(shown()).toBe('Standard')
  })

  it('Draft and High scale from those 4 steps, not from the 25 of the SD family', () => {
    expect(ladder().steps).toEqual({ Draft: 2, Standard: 4, High: 6 })
    click('Draft')
    expect(values()).toEqual({ steps: 2, cfgScale: 1 })
    expect(shown()).toBe('Draft')
    click('High')
    expect(values()).toEqual({ steps: 6, cfgScale: 1 })
    expect(shown()).toBe('High')
    click('Standard')
    expect(values()).toEqual({ steps: 4, cfgScale: 1 })
    expect(shown()).toBe('Standard')
  })

  it('a click brings the reported state back to the values of the model: 15 steps at CFG 5 become 2 at CFG 1', () => {
    useCreateStore.setState({ steps: 15, cfgScale: 5 })
    click('Draft')
    expect(values()).toEqual({ steps: 2, cfgScale: 1 })
  })

  it('means the same after a visit to another tab', () => {
    click('Draft')
    useCreateStore.getState().setIntent('music')
    useCreateStore.getState().setIntent('image')
    expect(values()).toEqual({ steps: 2, cfgScale: 1 })
    expect(shown()).toBe('Draft')
  })
})

describe('an ordinary checkpoint', () => {
  beforeEach(() => { useCreateStore.getState().setImageModel('dreamshaper_8.safetensors', 'sd15') })

  it('keeps 15 / 25 / 38', () => {
    expect(ladder()).toEqual({ steps: { Draft: 15, Standard: 25, High: 38 } })
    expect(shown()).toBe('Standard')
  })

  it('a click writes the steps and leaves CFG where the user put it', () => {
    useCreateStore.getState().setCfgScale(4.5)
    click('Draft')
    expect(values()).toEqual({ steps: 15, cfgScale: 4.5 })
    click('High')
    expect(values()).toEqual({ steps: 38, cfgScale: 4.5 })
    click('Standard')
    expect(values()).toEqual({ steps: 25, cfgScale: 4.5 })
  })
})

describe('the other ends', () => {
  it('no model gets a Draft below one step', () => {
    for (const type of Object.keys(MODEL_TYPE_DEFAULTS) as (keyof typeof MODEL_TYPE_DEFAULTS)[]) {
      const { steps } = imageQualityLadder({ backend: 'local', imageModel: 'sd_turbo.safetensors', imageModelType: type })
      expect(steps.Draft, type).toBeGreaterThanOrEqual(1)
      expect(steps.Draft, type).toBeLessThanOrEqual(steps.Standard)
      expect(steps.High, type).toBeGreaterThan(steps.Standard)
    }
  })

  it('HiDream dev and full measure from their own steps, not from those of the fast variant', () => {
    expect(imageQualityLadder({ backend: 'local', imageModel: 'hidream_i1_dev_bf16.safetensors', imageModelType: 'hidream' }).steps.Standard).toBe(28)
    expect(imageQualityLadder({ backend: 'local', imageModel: 'hidream_i1_full_fp16.safetensors', imageModelType: 'hidream' }).steps.Standard).toBe(50)
  })

  it('LU Cloud does not render the local file, so the family stays the measure there', () => {
    useCreateStore.getState().setImageModel('sd_turbo.safetensors', 'sd15')
    useCreateStore.setState({ backend: 'cloud', cfgScale: 5 })
    expect(ladder()).toEqual({ steps: { Draft: 15, Standard: 25, High: 38 } })
    click('Draft')
    expect(values()).toEqual({ steps: 15, cfgScale: 5 })
  })
})

describe('"Reset to model defaults" goes back to the picked model too', () => {
  const reset = () => useCreateStore.getState().resetParamsToModelDefaults()

  it('sd_turbo returns to its own 4 steps at CFG 1, not to the 25 of the SD family', () => {
    useCreateStore.getState().setImageModel('sd_turbo.safetensors', 'sd15')
    useCreateStore.setState({ steps: 40, cfgScale: 9 })
    reset()
    expect(values()).toEqual({ steps: 4, cfgScale: 1 })
  })

  it('an ordinary checkpoint returns to the values of its family, as before', () => {
    useCreateStore.getState().setImageModel('dreamshaper_8.safetensors', 'sd15')
    useCreateStore.setState({ steps: 40, cfgScale: 9 })
    reset()
    expect(values()).toEqual({ steps: MODEL_TYPE_DEFAULTS.sd15.steps, cfgScale: MODEL_TYPE_DEFAULTS.sd15.cfgScale })
  })

  it('a lightning video model returns to its 6 steps at CFG 1', () => {
    useCreateStore.getState().setIntent('video')
    useCreateStore.getState().setVideoModel('wan2.2_i2v_lightning_4steps.safetensors')
    useCreateStore.setState({ steps: 30, cfgScale: 6 })
    reset()
    expect(values()).toEqual({ steps: 6, cfgScale: 1 })
  })
})
