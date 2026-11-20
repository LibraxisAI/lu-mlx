/**
 * What the user is told about the model that looks at the screen.
 *
 * Measured on an RTX 3060 with 12 GB (06.10.2026): a 9B chat model takes
 * 6.9 GB and Holo 3.1 9B takes 7.7 GB. Both never fit together, each swap
 * takes about 20 seconds, and "type hello" by voice took 104 seconds with
 * the swap against about 35 seconds with the chat model alone. So the chat
 * model is the default, and a second local model comes with an honest note.
 */

import { executorFormatFor } from './executor-format'
import { BETA_LABEL } from '../beta'

/** Graphics memory from which a 9B chat model and a 9B screen model fit together. */
export const SCREEN_MODEL_COMFORT_GB = 16

/** The note under a local model picked next to the chat model. */
export function separateScreenModelHint(cardGb: number | null): string {
  if (cardGb === null) {
    return `Recommended from ${SCREEN_MODEL_COMFORT_GB} GB of graphics memory, or next to a small chat model. With less, LU swaps the two models for every task, and each swap takes about 20 seconds.`
  }
  if (cardGb < SCREEN_MODEL_COMFORT_GB) {
    return `On your ${cardGb} GB card this model and a 9B chat model do not fit together. LU swaps them for every task, and each swap takes about 20 seconds. "Same as the chat model" is faster here.`
  }
  return `Your ${cardGb} GB card holds it next to a 9B chat model, so nothing has to be swapped.`
}

/**
 * Holo as the model that looks at the screen is not dependable yet. Measured
 * in the real Windows build on 07.10.2026, "type hello into Notepad" by voice:
 * one of three runs ended as finished. In one the model clicked the same place
 * until the task gave up, in one it pressed Tab after typing and that was
 * declined. Its word is the app's one word for unfinished work (lib/beta.ts);
 * the measured sentence stays its own.
 */
export const BETA_SCREEN_MODEL_TAG = BETA_LABEL
export const BETA_SCREEN_MODEL_NOTE = `${BETA_LABEL}: in our test on Windows it finished a simple typing task in 1 of 3 runs.`

/** Is this a model whose work on the screen is not dependable yet? */
export function betaScreenModel(modelName: string): boolean {
  return executorFormatFor(modelName) === 'holo'
}

/** The short mark on a row of the picker. Null where the card is large enough. */
export function separateScreenModelTag(cardGb: number | null): string | null {
  return cardGb !== null && cardGb >= SCREEN_MODEL_COMFORT_GB ? null : `${SCREEN_MODEL_COMFORT_GB} GB+`
}

/**
 * The note when the chat model does the looking: what it works with right
 * now, and nothing else. How computer control runs follows the model (see
 * `modelSeesImages`); the note asks for nothing and offers nothing.
 * `treeAvailable` is null until the system has answered.
 */
export function chatScreenModelHint(input: {
  chatModel: string | null
  sees: boolean | null
  treeAvailable: boolean | null
}): string {
  const { chatModel, sees, treeAvailable } = input
  if (!chatModel) return 'No chat model is selected.'
  if (sees === null) return `${chatModel} is the chat model.`
  if (sees) return `${chatModel} works with pictures of the screen.`
  if (treeAvailable !== false) return `${chatModel} works from the list of buttons and fields of the window in front, without a picture.`
  return `${chatModel} cannot see the screen on this system.`
}
