/**
 * The onboarding model step on a Mac: the Model Manager's calculation and the
 * Model Manager's words.
 *
 * Fehlerkontrolle Mac 2, Fund 3: the step asked `detect_gpus` for a card and
 * ComfyUI for its statistics. A Mac has neither, so it knew nothing: the 7B
 * starter was "Recommended" on a 64 GB Mac, an 8 GB Mac got no advisory, and
 * both read "VRAM" and "measured on an RTX 3060".
 *
 * Negative control: with `sharedMemoryBudgetGb` answering null (the step as
 * it was, no reading on a Mac) the recommendation cases for 16 GB and 64 GB
 * and the advisory case for 8 GB are red.
 *
 * Run: npx vitest run src/lib/__tests__/onboarding-shared-memory.test.ts
 */
import { describe, it, expect } from 'vitest'
import { ONBOARDING_MODELS, onboardingModelCopy, recommendedOnboardingModelName } from '../constants'
import {
  recommendedOnSharedMemory,
  sharedMemoryAdvisory,
  sharedMemoryBudgetGb,
  sharedMemoryFit,
} from '../onboarding-shared-memory'
import { chatModelBudgetGb, pcHardwareLeft, sharedFitWords } from '../shared-memory-wording'
import { computeFit } from '../../components/models/ModelTiles'

const SEVEN_B = ONBOARDING_MODELS.find((m) => m.name === 'qwen2.5-7b')!
const NINE_B = ONBOARDING_MODELS.find((m) => m.name === 'qwen3.5-9b')!

describe('the budget is the Model Manager one', () => {
  it('is chatModelBudgetGb over the memory of the Mac', () => {
    for (const ram of [8, 16, 18, 24, 32, 36, 48, 64, 96, 128]) {
      expect(sharedMemoryBudgetGb(ram)).toBe(chatModelBudgetGb(true, null, ram))
    }
    expect(sharedMemoryBudgetGb(8)).toBe(6)
    expect(sharedMemoryBudgetGb(16)).toBe(11)
  })

  it('a failed probe is no reading, not an empty Mac', () => {
    expect(sharedMemoryBudgetGb(0)).toBeNull()
  })
})

describe('the verdict is the chat tile one', () => {
  it('agrees with computeFit for every size and budget on the grid', () => {
    for (let budget = 0; budget <= 96; budget += 1) {
      for (let size = 0; size <= 60; size += 0.5) {
        expect(sharedMemoryFit(size, budget || null), `${size} GB in ${budget} GB`)
          .toBe(computeFit(size, budget || null))
      }
    }
  })
})

describe('what a Mac is recommended', () => {
  const pick = (ramGb: number) => recommendedOnSharedMemory(ONBOARDING_MODELS, sharedMemoryBudgetGb(ramGb))

  it('8 GB: the 7B starter, because the 9B does not fit with room to spare', () => {
    expect(pick(8)).toBe(SEVEN_B.name)
  })

  it('16 GB and up: the 9B, no longer the 7B on every Mac', () => {
    expect(pick(16)).toBe(NINE_B.name)
    expect(pick(24)).toBe(NINE_B.name)
    expect(pick(64)).toBe(NINE_B.name)
  })

  it('no reading: the statically marked starter, as on a PC', () => {
    expect(recommendedOnSharedMemory(ONBOARDING_MODELS, null)).toBe(SEVEN_B.name)
    expect(recommendedOnSharedMemory(ONBOARDING_MODELS, null))
      .toBe(recommendedOnboardingModelName(ONBOARDING_MODELS, null))
  })
})

describe('what a Mac is warned about', () => {
  it('8 GB: the 9B carries the tight-fit sentence, the 7B none', () => {
    const budget = sharedMemoryBudgetGb(8)
    expect(sharedMemoryAdvisory(NINE_B, budget)).toBe(sharedFitWords('tight').title)
    expect(sharedMemoryAdvisory(SEVEN_B, budget)).toBe('')
  })

  it('a Mac too small for a model is told so in the Model Manager words', () => {
    expect(sharedMemoryAdvisory(NINE_B, 4)).toBe(sharedFitWords('big').title)
  })

  it('16 GB: nothing to warn about', () => {
    const budget = sharedMemoryBudgetGb(16)
    for (const m of ONBOARDING_MODELS) expect(sharedMemoryAdvisory(m, budget)).toBe('')
  })

  it('no reading: no verdict instead of a guessed one', () => {
    for (const m of ONBOARDING_MODELS) expect(sharedMemoryAdvisory(m, null)).toBe('')
  })

  it('no advisory names a card, a GPU or a PC', () => {
    for (const fit of ['tight', 'big'] as const) {
      const text = sharedFitWords(fit).title
      expect(pcHardwareLeft(text)).toEqual([])
      expect(text).not.toMatch(/GPU|offload/i)
    }
  })
})

describe('the words under a model', () => {
  it.each(ONBOARDING_MODELS)('$name on a Mac names no VRAM, no card, no GPU and no PC', (model) => {
    const copy = onboardingModelCopy(model, true)
    for (const text of [copy.description, copy.memory]) {
      expect(pcHardwareLeft(text), text).toEqual([])
      expect(text, text).not.toMatch(/GPU|offload|graphics/i)
    }
    expect(copy.memory).toBe(`Memory: about ${model.vramGB} GB free, context-dependent`)
  })

  it('the 9B keeps its number on a Mac and loses the RTX 3060', () => {
    const copy = onboardingModelCopy(NINE_B, true)
    expect(copy.description).toBe(`Better for agents and tools, without refusals. Needs about ${NINE_B.vramGB} GB of free memory.`)
  })

  it.each(ONBOARDING_MODELS)('WINDOWS CONTROL: $name reads exactly what the catalogue says', (model) => {
    const copy = onboardingModelCopy(model, false)
    expect(copy.description).toBe(model.description)
    expect(copy.memory).toBe(`VRAM: ${model.vram}`)
  })

  it('WINDOWS CONTROL: the PC text of the two entries has not moved', () => {
    expect(SEVEN_B.vram).toBe('about 6 GB for GPU offload, context-dependent')
    expect(NINE_B.vram).toBe('about 6.1 GB for GPU offload, context-dependent')
    expect(NINE_B.description).toBe('Better for agents and tools, without refusals. Needs about 6.1 GB VRAM, measured on an RTX 3060 with full GPU offload.')
  })
})
