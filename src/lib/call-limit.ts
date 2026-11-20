/**
 * One signal for a whole load or unload call to a local backend, and the
 * error such a call throws at its time limit.
 *
 * Shared by every backend whose models the picker loads by hand (api/ollama.ts,
 * api/lmstudio.ts), so a limit and a Cancel mean the same thing on each row.
 */

export interface CallLimitOptions {
  /** Ends the call early. The request to the backend is closed, not merely ignored. */
  signal?: AbortSignal
  /** Overrides the default limit of the call. */
  timeoutMs?: number
}

/** A load or unload that ran into its time limit. The message is for the screen. */
export class CallTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CallTimeoutError"
  }
}

/**
 * The signal aborts when the caller's signal does or when the limit is
 * reached, whichever comes first.
 *
 * The limit lives here and not only in a transport timeout, because a
 * transport may answer a failed call by sending the same request again, and
 * that second request would start a new wait. An aborted signal stops it
 * before the second request, so one limit covers both.
 */
export function callLimit(limitMs: number, outer?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, limitMs)
  const onOuter = () => controller.abort()
  if (outer?.aborted) controller.abort()
  else outer?.addEventListener("abort", onOuter, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    /** `work`, or an AbortError as soon as the signal aborts. */
    race<T>(work: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const stop = () => reject(new DOMException("Aborted", "AbortError"))
        if (controller.signal.aborted) { stop(); return }
        controller.signal.addEventListener("abort", stop, { once: true })
        work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", stop))
      })
    },
    clear() {
      clearTimeout(timer)
      outer?.removeEventListener("abort", onOuter)
    },
  }
}
