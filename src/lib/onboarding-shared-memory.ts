/**
 * The onboarding model step on a machine with one memory pool (a Mac).
 *
 * On a PC the step compares a model's `vramGB` with the detected card. A Mac
 * has no card: `detect_gpus` names the chip and leaves `memory_mib` empty, so
 * the step knew nothing, recommended the 7B starter on a 64 GB Mac and warned
 * nobody on an 8 GB one.
 *
 * The Model Manager already answers this for the Mac, and this file is that
 * answer and nothing new: the budget is `chatModelBudgetGb` (a share of the
 * pool, lib/shared-memory-wording.ts), the verdict is the size comparison of
 * the chat tiles (`computeFit` in components/models/ModelTiles.tsx), and the
 * words are `sharedFitWords`. The comparison is written out here instead of
 * imported because a lib file must not pull a component in; the test beside
 * this file runs both over the same grid, so they cannot drift apart.
 */

import type { OnboardingModel } from './constants'
import { chatModelBudgetGb, sharedFitWords } from './shared-memory-wording'
import type { VramFit } from './vram-fit'

/**
 * The memory a chat model may take on this Mac, in GB, or null when the pool
 * could not be read. `poolGb` is `getSharedMemoryGb()` (lib/hardware.ts): the
 * Apple entry of `detect_gpus`, with `system_info` behind it. A failed probe
 * (0) counts as no reading rather than as an empty machine.
 */
export function sharedMemoryBudgetGb(poolGb: number): number | null {
  return chatModelBudgetGb(true, null, poolGb > 0 ? poolGb : null)
}

/** Where a model file of `sizeGB` stands against that budget. */
export function sharedMemoryFit(sizeGB: number | undefined, budgetGb: number | null): VramFit {
  if (!sizeGB || !budgetGb) return 'unknown'
  if (sizeGB <= budgetGb * 0.85) return 'fits'
  if (sizeGB <= budgetGb * 1.15) return 'tight'
  return 'big'
}

/**
 * Which onboarding model gets "Recommended" on a Mac: the strongest one that
 * fits with room to spare. A tight fit is offered and explained, it is not
 * recommended. With no reading, or when nothing fits, the badge stays on the
 * entry statically marked `recommended`, exactly as on a PC.
 */
export function recommendedOnSharedMemory(
  models: OnboardingModel[],
  budgetGb: number | null,
): string | undefined {
  const fitting = models.filter((m) => sharedMemoryFit(m.sizeGB, budgetGb) === 'fits')
  if (fitting.length > 0) {
    return fitting.reduce((best, m) => (m.vramGB > best.vramGB ? m : best)).name
  }
  return models.find((m) => m.recommended)?.name
}

/**
 * The line under a model that does not fit comfortably, in the Model
 * Manager's own words. '' for a model that fits and for an unknown machine:
 * an unmeasured Mac gets no verdict instead of a guessed one.
 */
export function sharedMemoryAdvisory(model: OnboardingModel, budgetGb: number | null): string {
  const fit = sharedMemoryFit(model.sizeGB, budgetGb)
  return fit === 'tight' || fit === 'big' ? sharedFitWords(fit).title : ''
}
