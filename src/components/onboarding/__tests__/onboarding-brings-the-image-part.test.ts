/**
 * The onboarding pick with image input brings its image part along.
 *
 * The owner's test machine got its Qwen 3.5 9B through exactly this step, and
 * the step fetched one file. The model came up without image input and
 * computer control worked blind.
 *
 * Run: npx vitest run src/components/onboarding/__tests__/onboarding-brings-the-image-part.test.ts
 */
import { describe, expect, it } from 'vitest'
import { ONBOARDING_MODELS } from '../../../lib/constants'
import { getUncensoredTextModels } from '../../../api/discover'
import { onboardingPlan } from '../ModelsStep'

const nine = ONBOARDING_MODELS.find((m) => m.name === 'qwen3.5-9b')!
const starter = ONBOARDING_MODELS.find((m) => m.name === 'qwen2.5-7b')!

describe('the onboarding download', () => {
  it('names the same image part as the catalog entry of the same file', () => {
    const catalog = getUncensoredTextModels().find((m) => m.filename === nine.filename)!
    expect(nine.mmprojUrl).toBe(catalog.mmprojUrl)
    expect(nine.mmprojBytes).toBe(catalog.mmprojBytes)
    expect(nine.mmprojSha256).toBe(catalog.mmprojSha256)
  })

  it('fetches model and part as two files of one plan, each with size and digest', () => {
    expect(onboardingPlan(nine)).toEqual([
      { url: nine.downloadUrl, filename: 'Qwen3.5-9B-abliterated.Q4_K_M.gguf', expectedBytes: 5627045216, sha256: nine.sha256 },
      { url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf', filename: 'Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf', expectedBytes: 918166080, sha256: nine.mmprojSha256 },
    ])
  })

  it('leaves the text starter at one file', () => {
    expect(starter.mmprojUrl).toBeUndefined()
    expect(onboardingPlan(starter)).toHaveLength(1)
  })
})
