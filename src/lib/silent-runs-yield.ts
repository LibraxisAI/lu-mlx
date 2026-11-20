import { laneOf, currentLaneFacts } from './run-lane-of-model'
import { yieldSilentLocalRuns } from './silent-runs'

/**
 * A person starts work on a model: a message in a chat, an instruction to the
 * agent, a voice session. If that model runs on this machine, the silent runs
 * on the local lane step aside first (lib/silent-runs.ts), so the work does
 * not wait behind a memory extraction nobody can see or stop.
 *
 * A hosted model waits for nothing on this machine, so nothing is ended for
 * it. Returns how many silent runs were ended.
 *
 * Only for what a person does by hand. A pass of /loop, the wake-up turn of a
 * background agent and every other turn the app starts by itself do not call
 * this: they would end the extraction of the turn before them every time.
 *
 * Never throws. A silent run that is ended here saves nothing, and nothing picks it up
 * later: the extraction of that one turn, or the digest of that one voice
 * session, is gone.
 */
export function yieldSilentRunsTo(model: string | null | undefined): number {
  if (!model) return 0
  try {
    return laneOf(model, currentLaneFacts()) === 'local' ? yieldSilentLocalRuns() : 0
  } catch {
    // Stepping aside is a courtesy to the start that follows. It never costs
    // that start: whatever went wrong here, the message is still sent.
    return 0
  }
}
