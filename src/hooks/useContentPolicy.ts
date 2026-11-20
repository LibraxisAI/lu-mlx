import { useEffect, useState } from 'react'
import { getContentPolicy, type ContentPolicy } from '../api/cloud/jobs'

/**
 * C2: the account's content policy, fetched once and shared across every
 * surface that only needs it for DISPLAY (today: ModelChip's "No Filter"
 * mark). Mirrors the web app so the same
 * rule reads the same way on both sides: a small module-level cache plus a
 * listener set, instead of every mounted ModelChip firing its own GET.
 *
 * Read-only. The server re-checks the real policy on every render job
 * (ContentPolicySettings.tsx already owns the write path); a stale or wrong
 * value here mislabels a badge, it grants nothing.
 */
let cached: ContentPolicy | null = null
let inflight: Promise<ContentPolicy> | null = null
const listeners = new Set<(p: ContentPolicy) => void>()

export async function loadContentPolicy(): Promise<ContentPolicy> {
  if (cached) return cached
  if (!inflight) {
    inflight = getContentPolicy()
      .then((s) => {
        // A concurrent write (ContentPolicySettings' save()) may already have
        // primed the cache while this GET was in flight, and that newer value
        // wins, this response must not overwrite it.
        if (cached) return cached
        cached = s.policy
        listeners.forEach((l) => l(s.policy))
        return s.policy
      })
      .catch(() => 'soft' as ContentPolicy)
      .finally(() => { inflight = null })
  }
  return inflight
}

/**
 * The policy as currently known, without triggering a fetch. `null` means
 * "not loaded yet"; a caller that needs to act on it (B3: the client-side
 * cloud adult gate in useCloudCreate) must treat that as "unknown", not as
 * a guessed rule, mirroring the web app's contentPolicySnapshot().
 */
export function contentPolicySnapshot(): ContentPolicy | null {
  return cached
}

/** Push a freshly saved policy into the shared cache (call after a
 *  successful PUT), so every mounted ModelChip picks it up immediately
 *  instead of waiting for a reload. */
export function primeContentPolicyCache(policy: ContentPolicy): void {
  cached = policy
  listeners.forEach((l) => l(policy))
}

/** Test-only: drop the cache between cases. */
export function _resetContentPolicyCache(): void {
  cached = null
  inflight = null
}

export function useContentPolicy(): ContentPolicy {
  const [policy, setPolicy] = useState<ContentPolicy>(cached ?? 'soft')
  useEffect(() => {
    listeners.add(setPolicy)
    void loadContentPolicy().then(setPolicy)
    return () => { listeners.delete(setPolicy) }
  }, [])
  return policy
}
