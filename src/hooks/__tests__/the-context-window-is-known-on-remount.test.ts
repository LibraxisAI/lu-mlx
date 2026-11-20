/**
 * @vitest-environment jsdom
 *
 * Gegenprobe 01.10.2026: the context counter mounts with a conversation's
 * first message. A fresh mount started unresolved and divided by a stand-in
 * for the length of the provider probe: "18/16K", then "30/32K". A mount now
 * starts from the window this model last resolved to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const probe = vi.hoisted(() => ({ calls: 0, release: null as null | (() => void) }))

vi.mock('../../lib/context-compaction', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/context-compaction')>()
  return {
    ...real,
    getModelMaxTokens: async () => {
      probe.calls++
      if (probe.calls > 1) await new Promise<void>((r) => { probe.release = r })
      return 131072
    },
  }
})

import { useActiveContextWindow } from '../useActiveContextWindow'
import { useModelStore } from '../../stores/modelStore'

const MODEL = 'lu-cloud::zai-org/GLM-5.3'

beforeEach(() => {
  useModelStore.setState({ activeModel: MODEL })
})

describe('the counter after a remount', () => {
  it('knows the window at once, the probe only refreshes it', async () => {
    const first = renderHook(() => useActiveContextWindow())
    await waitFor(() => expect(first.result.current.sendWindow).toBeGreaterThan(0))
    const known = first.result.current.sendWindow
    first.unmount()

    // The second probe hangs: whatever shows now comes from before.
    const second = renderHook(() => useActiveContextWindow())
    expect(second.result.current.sendWindow).toBe(known)
    probe.release?.()
  })
})
