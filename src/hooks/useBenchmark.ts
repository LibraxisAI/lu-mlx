/**
 * Benchmark Runner — runs standardized prompts against a model and measures performance.
 */

import { useCallback, useRef } from 'react'
import { useBenchmarkStore } from '../stores/benchmarkStore'
import { getProviderForModel } from '../api/providers'
import { BENCHMARK_PROMPTS } from '../lib/benchmark-prompts'
import { measureRun } from '../lib/benchmark-run'
import type { ChatMessage } from '../api/providers/types'
import { runInLane } from '../lib/run-slot'
import { laneOf, currentLaneFacts } from '../lib/run-lane-of-model'
import { useGenerationStore } from '../stores/generationStore'

/**
 * Booking identity for the local lane, standing in for a `conversationId`.
 *
 * Runde 4 (review-lanes.md Blocker 1+6, Schritt 1 "andere Verbraucher der
 * lokalen Spur"): a benchmark run fires the exact same `provider.chatStream`
 * a visible chat turn does, against the model under test, prompt after
 * prompt. Before this it was invisible to `lib/run-lanes.ts`: a local chat
 * running at the same time raced it for the same engine, the VRAM-swap this
 * whole module exists to prevent, just triggered from Settings instead of
 * the composer. A fixed, single id is enough (unlike the memory-extraction
 * case in `useMemory.ts`): `runBenchmark` already refuses to start a second
 * run while one is active (`runningRef`), so this id is never held by two
 * benchmark runs at once.
 */
export const BENCHMARK_LANE_ID = 'lib:benchmark-run'

export function useBenchmark() {
  const store = useBenchmarkStore()
  const abortRef = useRef<AbortController | null>(null)
  // Stop has to reach the LOOP, not just the request in flight. Aborting the
  // stream only ended the current prompt; the next iteration opened a fresh
  // controller and carried on against the same model, so Stop looked like
  // "skip this one" (review 2026-08-14).
  const stoppedRef = useRef(false)
  // The guard cannot read store.isRunning: that value is captured when the
  // hook renders, so two clicks in the same frame both saw false and started
  // two loops on one GPU.
  const runningRef = useRef(false)

  const runBenchmark = useCallback(async (modelName: string) => {
    if (runningRef.current) return
    runningRef.current = true
    stoppedRef.current = false

    store.setRunning(true, modelName, BENCHMARK_PROMPTS.length)
    store.setError(null)

    try {
      // A local model under test books the same lane a chat turn would; a
      // cloud model starts immediately, same as `admit` decides everywhere
      // else. If the lane is held by a running chat, this call queues here
      // and the whole prompt loop below starts only once its turn comes.
      // `abort` only matters for that queued wait (see run-slot.ts): once
      // the loop itself is running, Stop already reaches it through
      // `abortRef`.
      await runInLane(
        { conversationId: BENCHMARK_LANE_ID, lane: laneOf(modelName, currentLaneFacts()), abort: () => abortRef.current?.abort() },
        async () => {
          try {
            for (let i = 0; i < BENCHMARK_PROMPTS.length; i++) {
              if (stoppedRef.current) break
              const prompt = BENCHMARK_PROMPTS[i]
              store.setStep(i + 1)

              abortRef.current = new AbortController()

              try {
                const { provider, modelId } = getProviderForModel(modelName)
                const messages: ChatMessage[] = [
                  { role: 'user', content: prompt.prompt },
                ]

                const stream = provider.chatStream(modelId, messages, {
                  temperature: 0.7,
                  signal: abortRef.current.signal,
                })

                // The brake aborts the request itself, not just our reading
                // of it: dropping the stream would leave the model
                // generating into nothing, still holding the GPU (a user,
                // issue #106).
                const controller = abortRef.current
                const m = await measureRun(stream, prompt.check, {
                  onLimit: () => controller.abort(),
                })

                store.addResult({
                  modelName,
                  promptId: prompt.id,
                  tokensPerSec: m.tokensPerSec,
                  timeToFirstToken: m.timeToFirstToken,
                  totalTime: m.totalTime,
                  totalTokens: m.totalTokens,
                  thinkTokens: m.thinkTokens,
                  finishReason: m.finishReason,
                  correct: m.correct,
                  timestamp: Date.now(),
                })
              } catch (e) {
                // A prompt the user stopped is not a failure. Anything else
                // is, and it used to vanish into a bare catch: a model that
                // could not be reached at all produced an empty run that
                // read exactly like a finished one, with no message anywhere.
                if (stoppedRef.current || abortRef.current?.signal.aborted) break
                store.setError(
                  `${modelName}: ${e instanceof Error ? e.message : String(e)}. ` +
                  'Nothing was recorded for this run.',
                )
                break
              }
            }
          } finally {
            abortRef.current = null
          }
        },
      )
    } finally {
      runningRef.current = false
      store.setRunning(false)
    }
  }, [store])

  const stopBenchmark = useCallback(() => {
    // Order matters: the flag first, so the loop cannot start the next prompt
    // between the abort and the check. setRunning stays out of here, the run's
    // own finally owns it, or Stop would re-enable Run while the loop is still
    // winding down and a second loop could start on the same GPU.
    stoppedRef.current = true
    abortRef.current?.abort()
    // Reaches a benchmark that has not started yet, still queued on the local
    // lane behind a running chat: `abortRef` is still null at that point (the
    // loop above has not run once), so the line above alone does nothing.
    // `abortConversation` calls the abort callback `runInLane` registered at
    // admission time, which for a still-queued run dequeues it instead of
    // aborting a stream that does not exist yet (see run-slot.ts).
    useGenerationStore.getState().abortConversation(BENCHMARK_LANE_ID)
  }, [])

  return { runBenchmark, stopBenchmark }
}
