import { describe, it, expect } from 'vitest'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'
import { forThisPlatform, isMlxOnlyBuild } from '../mlx-only-builds'

describe('MLX builds in Ollama are a Mac matter', () => {
  const all = [...getMainstreamTextModels(), ...getUncensoredTextModels()]

  it('the catalogue carries such builds, or this test proves nothing', () => {
    expect(all.filter(isMlxOnlyBuild).length).toBeGreaterThanOrEqual(5)
  })

  it('a PC does not see them', () => {
    const pc = forThisPlatform(all, false)
    expect(pc.filter(isMlxOnlyBuild)).toEqual([])
    expect(pc.some((m) => /NVFP4|MXFP8|MLX BF16/.test(m.name))).toBe(false)
  })

  it('a Mac sees all of them', () => {
    expect(forThisPlatform(all, true)).toHaveLength(all.length)
  })

  it('a GGUF with MLX in a tag but no Ollama name stays', () => {
    expect(isMlxOnlyBuild({ tags: ['MLX'], ollamaModel: undefined })).toBe(false)
  })
})
