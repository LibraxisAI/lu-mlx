/**
 * The tag of a Mac model in Create's model picker is its family (persona
 * walk of the Mac app, 09.10.2026, Fund 23).
 *
 * SD Turbo carried "SD 1.5" and stood under "Older models": the tag was read
 * from the type, and the type only says which set of values Create opens on.
 *
 * Run: npx vitest run src/api/__tests__/mlx-picker-family.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildMlxImageModels, mlxPickerFamily, mlxModelType, type MlxImageModel } from '../mlx-image'
import { localTier } from '../../lib/render/local-model-tier'
import { TYPE_LABEL } from '../../components/create/experimental/badges'

const model = (id: string, name: string, defaultSize: number): MlxImageModel => ({
  id, name, repo: 'a/b', sizeGB: 1, sizeBytes: 1e9, minRamGB: 8, steps: 4, guidance: 0, defaultSize,
  unfiltered: false, description: '', installed: true,
})

const CATALOGUE = [
  model('sd-turbo', 'SD Turbo', 512),
  model('realistic-vision-v51', 'Realistic Vision V5.1', 512),
  model('juggernaut-xl-v9', 'Juggernaut XL v9', 1024),
  model('flux2-klein-4b-4bit', 'FLUX.2 klein 4B 4-bit', 1024),
  model('z-image', 'Z-Image', 1024),
  model('z-image-turbo-8bit', 'Z-Image Turbo 8-bit', 1024),
  model('chroma1-hd', 'Chroma1-HD', 1024),
  model('qwen-image-2512-8bit', 'Qwen-Image 2512 8-bit', 1024),
  model('qwen-image-2.1-8bit', 'Qwen-Image 2.1 8-bit', 1024),
]

/** The tag and the tier as LocalModelChip works them out on a Mac. */
const row = (name: string) => {
  const m = buildMlxImageModels(CATALOGUE).find((x) => x.name === name)!
  const family = mlxPickerFamily(name)
  return { tag: family?.label ?? TYPE_LABEL[m.type], tier: localTier({ name, type: family?.type ?? m.type }) }
}

describe('the picker row of a Mac model', () => {
  it('SD Turbo is SD Turbo, and not an older model', () => {
    expect(row('MLX SD Turbo')).toEqual({ tag: 'SD Turbo', tier: 'standard' })
    // What the type alone said.
    expect(TYPE_LABEL[mlxModelType({ id: 'sd-turbo', defaultSize: 512 })]).toBe('SD 1.5')
  })

  it('every other family the type table cannot tell from SDXL gets its own name', () => {
    expect(row('MLX FLUX.2 klein 4B 4-bit')).toEqual({ tag: 'FLUX 2', tier: 'best' })
    expect(row('MLX Z-Image')).toEqual({ tag: 'Z-Image', tier: 'best' })
    expect(row('MLX Z-Image Turbo 8-bit')).toEqual({ tag: 'Z-Image', tier: 'best' })
    expect(row('MLX Chroma1-HD')).toEqual({ tag: 'Chroma', tier: 'standard' })
    expect(row('MLX Qwen-Image 2512 8-bit')).toEqual({ tag: 'Qwen Image', tier: 'standard' })
  })

  it('a model whose type is its family keeps the type', () => {
    expect(mlxPickerFamily('MLX Realistic Vision V5.1')).toBeNull()
    expect(row('MLX Realistic Vision V5.1')).toEqual({ tag: 'SD 1.5', tier: 'older' })
    expect(row('MLX Juggernaut XL v9')).toEqual({ tag: 'SDXL', tier: 'older' })
    expect(row('MLX Qwen-Image 2.1 8-bit')).toEqual({ tag: 'Qwen Image 2.1', tier: 'best' })
  })

  it('COUNTER-CHECK: a file of a ComfyUI host is no Mac model and gets no answer', () => {
    expect(mlxPickerFamily('sd_turbo.safetensors')).toBeNull()
    expect(mlxPickerFamily('flux2-klein-4b.safetensors')).toBeNull()
    expect(mlxPickerFamily('')).toBeNull()
  })
})
