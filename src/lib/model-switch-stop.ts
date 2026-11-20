import { useGenerationStore } from '../stores/generationStore'

/**
 * "This answer ended because you switched to another model", as a fact the
 * run can ask for when it ends.
 *
 * A local backend holds one model. Picking another one while an answer is
 * still being written takes the engine away from under it: the built-in
 * engine restarts with the new file, and the stream of the old answer closes.
 * Nothing in the app aborts that run, so it used to end like any dropped
 * connection ("Connection dropped before the end", or the long sentence about
 * a backend that may have crashed), and the one thing the person had just
 * done was not named as the reason.
 *
 * The pick is not held back and nobody is asked: `noteModelSwitch` only
 * writes down which runs were on the local lane at that moment. A run that
 * then ends without finishing reads the note and says so. A run that finishes
 * anyway (a backend that lets the old answer run out) never asks.
 *
 * The note is good for a short while only. The stream closes when the engine
 * is taken away, not minutes later, and a failure long after the pick has
 * another cause and keeps its own sentence.
 */

/** The value of `finishReason` on an answer that ended this way. */
export const MODEL_SWITCH_FINISH = 'model_switch'

const SWITCH_STOP_WINDOW_MS = 30_000

/** conversationId → when the model was switched under its running answer. */
const switchedAt = new Map<string, number>()

/** The person picked another model. Marks every run on the local lane. */
export function noteModelSwitch(now: number = Date.now()): void {
  for (const [runId, run] of Object.entries(useGenerationStore.getState().runs)) {
    if (run.lane === 'local') switchedAt.set(runId, now)
  }
}

/** A new run starts on this conversation: a note of an earlier one is void. */
export function beginModelSwitchWatch(conversationId: string | null | undefined): void {
  if (conversationId) switchedAt.delete(conversationId)
}

/** Did the model get switched under the run of this conversation just now? */
export function cutByModelSwitch(conversationId: string | null | undefined, now: number = Date.now()): boolean {
  if (!conversationId) return false
  const at = switchedAt.get(conversationId)
  return at !== undefined && now - at <= SWITCH_STOP_WINDOW_MS
}

/** A stream that reports a dropped connection, read with the note in hand. */
export function finishReasonAfterSwitch(finishReason: string, conversationId: string | null | undefined): string {
  return finishReason === 'disconnect' && cutByModelSwitch(conversationId) ? MODEL_SWITCH_FINISH : finishReason
}

/** Test-only: module state lasts a session by design. */
export function __resetModelSwitchStopsForTests(): void {
  switchedAt.clear()
}
