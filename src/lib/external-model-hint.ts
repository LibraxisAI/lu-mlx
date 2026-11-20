// Discord 2026-09-28 ("DELETE BUTTON"): the chat rows without a bin
// are models another app serves, LM Studio in his screenshot. LM Studio has
// no delete in its API or in `lms`, and its model list names no file, so LU
// cannot delete them without guessing which file is meant. The owner decided on
// 2026-10-01: the row says where the model is deleted instead.

import { PROVIDER_PRESETS } from '../api/providers/types'

/** A local server serves files from its own disk, which only it deletes. A
 *  cloud preset (OpenRouter and the like) has nothing to delete at all, and
 *  a config named by hand is taken as the local server it nearly always is. */
export function servesItsOwnFiles(provider: string | undefined, providerName: string | undefined): boolean {
  if (provider !== 'openai') return false
  const preset = PROVIDER_PRESETS.find((p) => p.name === providerName?.trim())
  return preset ? preset.isLocal === true : true
}

/** The model belongs to the app that serves it, and that app deletes it. */
export function externalDeleteHint(providerName: string | undefined): string {
  const app = providerName?.trim()
  if (app && /lm ?studio/i.test(app)) return 'This model belongs to LM Studio. Delete it in LM Studio under My Models.'
  return `This model belongs to ${app || 'the app that serves it'}. Delete it there.`
}
