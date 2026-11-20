/**
 * The load switch of an LM Studio row in the model picker.
 *
 * It follows the rule every load switch follows (lib/load-switch.ts). What is
 * LM Studio's own:
 *
 *   - A pick of an LM Studio model that is not loaded IS a load, so the rows
 *     are switched off while one runs (`pickInFlight` in the picker). That
 *     load is ended where every load is ended: on the switch of its row.
 *   - LM Studio loads through its `lms` command, which reports no queue. A
 *     pending load therefore has no "waiting for" line; it has a limit, a
 *     Cancel, and the command's own sentence when it fails.
 *   - Whether a load or unload really happened is read from LM Studio's
 *     loaded list afterwards, never taken from the command's answer.
 *   - A cancelled load is not over when its `lms` command is: LM Studio may
 *     finish it on its own. Until LM Studio has let go of the model the row
 *     says "Cancelling" and is neither on nor off
 *     (lib/lmstudio-ended-loads.ts). The other rows are free in that time.
 *
 * Pure, so the rule can be tested without mounting the picker.
 */
import { loadSwitchState, loadSwitchFailedSentence, type LoadSwitchRun, type LoadSwitchState } from './load-switch'

/** The LM Studio load or unload that is running, and which click started it. */
export interface LmStudioSwitchRun extends LoadSwitchRun {
  /** `switch`: the On/Off switch of the row. `pick`: picking the row, which loads it first. */
  via: 'switch' | 'pick'
}

/**
 * The state of one row's switch. `otherLoadRunning` is a load in the same
 * picker that is not LM Studio's (the LU Engine swapping a model): it has no
 * Cancel on an LM Studio row, and no LM Studio switch may start beside it.
 * `ending` are the models whose ended load LM Studio still holds.
 */
export function lmStudioSwitchState(
  rowId: string,
  run: LmStudioSwitchRun | null,
  otherLoadRunning: boolean,
  ending: ReadonlySet<string>,
): LoadSwitchState {
  if (ending.has(rowId)) return 'cancelling'
  if (!run && otherLoadRunning) return 'off'
  return loadSwitchState(rowId, run)
}

/** Said when LM Studio answered an unload and the model is still in its loaded list. */
export const LM_STUDIO_STILL_LISTED = 'LM Studio still lists it as loaded.'

const REASON_MAX_CHARS = 240

/**
 * The reason the `lms` command gave, made fit for one line on screen: without
 * the bridge's own prefix, terminal colour codes and line breaks, and not
 * longer than a sentence or two. Undefined when it gave none.
 */
export function lmStudioReason(raw: string): string | undefined {
  const text = raw
    // eslint-disable-next-line no-control-regex -- terminal colour codes are control characters
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^(?:spawn )?lms (?:load|unload)(?: failed)?:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS).trimEnd()}...` : text
}

/** What the picker says when an LM Studio switch did not do what was asked. */
export function lmStudioSwitchFailedSentence(
  kind: LoadSwitchRun['kind'],
  label: string,
  failure: { timedOut: boolean; reason?: string },
): string {
  return loadSwitchFailedSentence('LM Studio', kind, label, failure)
}
