/**
 * @vitest-environment jsdom
 *
 * B3 (review-w2ui.md, 18.09.2026): checkPromptSafety's adult half
 * (ADULT_SOFT_TERMS/ADULT_HARD_TERMS) only fires with `tier: 'cloud'`, and no
 * caller ever passed that, making it unreachable. R5-9's own wording is
 * "damit die Ablehnung vor dem Upload kommt" (so the rejection comes before
 * the upload), this is the test AT THE CALLER the fixliste line asks for.
 *
 * useCloudCreate.generate() and .makeVoice() are exercised end to end (real
 * createStore, mocked network/catalog layer) with a hardcore adult prompt.
 * Before the fix, this prompt passed the client gate silently and went on to
 * call uploadInput/submitCloudJob; after the fix it is refused before either
 * runs, exactly like the web app's own useCloudCreate.
 *
 * Run: npx vitest run src/hooks/__tests__/useCloudCreate-b3-adult-gate-fires-before-upload.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const hoisted = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    code?: string
    retryAfterMs?: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    policySnapshot: 'strict' as 'strict' | 'soft' | 'off' | null,
    submitCloudJob: vi.fn(async () => ({ id: 'job-1' })),
    uploadInput: vi.fn(async () => 'uploaded/path'),
    getJob: vi.fn(),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    // 'canceled' short-circuits the post-submit result handling in both
    // generate() and makeVoice() cleanly, this test only cares about what
    // happens BEFORE submitCloudJob, not the full success path.
    pollJob: vi.fn(async () => ({ id: 'job-1', status: 'canceled' as const })),
    FakeCloudJobError,
  }
})
const { submitCloudJob, uploadInput } = hoisted

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => hoisted.policySnapshot,
  loadContentPolicy: async () => hoisted.policySnapshot ?? 'soft',
}))

vi.mock('../../api/cloud/jobs', () => ({
  submitCloudJob: (...a: Parameters<typeof hoisted.submitCloudJob>) => hoisted.submitCloudJob(...a),
  uploadInput: (...a: Parameters<typeof hoisted.uploadInput>) => hoisted.uploadInput(...a),
  getJob: (...a: Parameters<typeof hoisted.getJob>) => hoisted.getJob(...a),
  cancelJob: (...a: Parameters<typeof hoisted.cancelJob>) => hoisted.cancelJob(...a),
  pollJob: (...a: Parameters<typeof hoisted.pollJob>) => hoisted.pollJob(...a),
  CloudJobError: hoisted.FakeCloudJobError,
}))

vi.mock('../../stores/cloudCatalogStore', () => ({
  defaultCloudModel: () => ({ id: 'test-model' }),
  modelForOp: () => 'test-model',
  resolveOpPick: () => 'test-model',
  cloudModelById: () => undefined,
  cloudMediaLive: () => true,
  // No rule by length for the test model: the start sends no ceiling.
  lengthPrice: () => undefined,
  lengthCredits: () => 0,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { blockMessageFor } from '../../lib/render/safety'

beforeEach(() => {
  submitCloudJob.mockClear()
  uploadInput.mockClear()
  hoisted.policySnapshot = 'strict'
  useCreateStore.setState({
    prompt: '',
    negativePrompt: '',
    musicLyrics: '',
    triggerWord: '',
    isGenerating: false,
    error: null,
  } as Partial<ReturnType<typeof useCreateStore.getState>>)
})

describe('B3: useCloudCreate.generate() runs the adult gate before any upload/submit', () => {
  it('a hardcore adult prompt is refused, uploadInput and submitCloudJob are never called', async () => {
    useCreateStore.getState().setPrompt('hardcore porn scene')
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => {
      await result.current.generate()
    })
    expect(uploadInput).not.toHaveBeenCalled()
    expect(submitCloudJob).not.toHaveBeenCalled()
    expect(useCreateStore.getState().error).toBe(blockMessageFor('adult-cloud'))
    expect(useCreateStore.getState().error).not.toBe(blockMessageFor('csam'))
  })

  it('the same prompt is NOT blocked once the account policy is "off" (never a guessed rule)', async () => {
    hoisted.policySnapshot = 'off'
    useCreateStore.getState().setPrompt('hardcore porn scene')
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => {
      await result.current.generate()
    })
    expect(submitCloudJob).toHaveBeenCalledOnce()
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('NEGATIVE CONTROL: an ordinary prompt is never blocked and still submits', async () => {
    useCreateStore.getState().setPrompt('a mountain landscape at sunrise')
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => {
      await result.current.generate()
    })
    expect(submitCloudJob).toHaveBeenCalledOnce()
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('CSAM still wins the reason even with tier: cloud wired in (never softened to adult-cloud)', async () => {
    useCreateStore.getState().setPrompt('child porn')
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => {
      await result.current.generate()
    })
    expect(submitCloudJob).not.toHaveBeenCalled()
    expect(useCreateStore.getState().error).toBe(blockMessageFor('csam'))
  })
})

describe('B3: useCloudCreate.makeVoice() runs the same gate', () => {
  it('a hardcore adult voice description is refused before submitCloudJob', async () => {
    const { result } = renderHook(() => useCloudCreate())
    await act(async () => {
      await result.current.makeVoice({ text: 'hardcore porn scene', mode: 'design', description: 'narrator' })
    })
    expect(submitCloudJob).not.toHaveBeenCalled()
    expect(useCreateStore.getState().error).toBe(blockMessageFor('adult-cloud'))
  })
})
