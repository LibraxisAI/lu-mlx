import { useGenerationStore } from '../stores/generationStore'

/**
 * Silent runs on a local model, and the one way to make them step aside.
 *
 * A silent run is a model call nobody asked for by hand and nobody sees: the
 * memory extraction after a turn, and the digest of a whole voice session.
 * On a local backend it holds the model like any chat turn does, and a local
 * backend cannot swap a model that is still computing. So a person who picks,
 * loads or unloads a model while such a run is going waits behind work they
 * never started and cannot see, with nothing on screen to stop.
 *
 * What the person just did by hand outranks what the app does on its own:
 * `yieldSilentLocalRuns` ends every silent run on the local lane, running or
 * still queued. The abort goes down the same chain Stop uses, so the request
 * to the backend is closed and not merely ignored. A silent run that is cut
 * short saves nothing and reports nothing; that was its contract before.
 *
 * Runs on a hosted model are left alone: they hold no local model.
 */

const SILENT_RUN_SUFFIXES = ['::memory-extraction'] as const

/** The lane booking of the memory extraction that belongs to a conversation. */
export function memoryExtractionRunId(conversationId: string): string {
  return `${conversationId}${SILENT_RUN_SUFFIXES[0]}`
}

export function isSilentRunId(runId: string): boolean {
  return SILENT_RUN_SUFFIXES.some((suffix) => runId.endsWith(suffix))
}

/**
 * End every silent run that holds, or waits for, the local model. Returns how
 * many it ended. Safe to call when there is none.
 */
export function yieldSilentLocalRuns(): number {
  const { runs, abortConversation } = useGenerationStore.getState()
  let ended = 0
  for (const [runId, run] of Object.entries(runs)) {
    if (run.lane !== 'local' || !isSilentRunId(runId)) continue
    abortConversation(runId)
    ended += 1
  }
  return ended
}
