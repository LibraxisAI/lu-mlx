/**
 * Did a failed step get fixed later in the same run?
 *
 * Gegenprobe 01.10.2026: Mistral first wrote poem.txt to the user's Desktop,
 * the folder guard refused it, and the next step wrote poem.txt into the
 * chat's own folder. The run ended well, and still the steps header showed a
 * red mark and a line above the chat said "then ask again". A failure the run
 * fixed by itself is not news for the customer. The failed step keeps its own
 * red mark inside the expanded list, where it is the truth about that step.
 *
 * Fixed means: a LATER call of the same tool succeeded, on the same file name
 * when the calls carry a path. A read of data.csv that failed is not fixed by
 * a read of notes.txt.
 */

type Step = {
  toolName: string
  status: string
  args?: unknown
}

const OK = new Set(['completed', 'cached'])

function baseName(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const path = (args as Record<string, unknown>).path
  if (typeof path !== 'string' || !path.trim()) return null
  const parts = path.trim().split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1].toLowerCase() : null
}

/** Does the step at `index` count as fixed by a later step in `steps`? */
export function isRecovered(steps: readonly Step[], index: number): boolean {
  const failed = steps[index]
  if (!failed) return false
  const name = baseName(failed.args)
  for (let i = index + 1; i < steps.length; i++) {
    const later = steps[i]
    if (later.toolName !== failed.toolName || !OK.has(later.status)) continue
    if (name === null || baseName(later.args) === name) return true
  }
  return false
}

/** A failed step the run did not fix, or a step the user rejected (a tick
 *  next to a rejection would claim it ran). */
export function hasUnrecoveredFailure(steps: readonly Step[]): boolean {
  return steps.some((s, i) => s.status === 'rejected' || (s.status === 'failed' && !isRecovered(steps, i)))
}
