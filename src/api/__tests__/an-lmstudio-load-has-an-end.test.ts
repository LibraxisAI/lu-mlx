import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * An LM Studio load has an end, the same end an Ollama load got on
 * 10.10.2026 (an-ollama-load-has-an-end.test.ts).
 *
 * `loadLmStudioModel` was one call to the bridge, and the bridge ran
 * `lms load`, which returns only when the model is in memory. Neither side
 * had a limit, and nothing could stop it. There is no request to close here:
 * the only handle on a running load is the `lms` process, so ending a load
 * means telling the bridge to kill it, by the id the load was started with.
 *
 * And the other half: an answer to `lms unload` is not proof that the model
 * left. Whoever unloads has to read the loaded list afterwards, and a list
 * that could not be read is not an empty one.
 *
 * Run: npx vitest run src/api/__tests__/an-lmstudio-load-has-an-end.test.ts
 */

type Args = Record<string, unknown> | undefined
const backendCall = vi.fn(async (_command: string, _args?: Args): Promise<unknown> => ({}))

vi.mock('../backend', () => ({
  backendCall: (command: string, args?: Args) => backendCall(command, args),
}))

import {
  loadLmStudioModel, unloadLmStudioModel, unloadLmStudioModelAndLook,
  listLoadedLmStudioModels, readLoadedLmStudioModels,
  LmStudioTimeoutError, LmStudioSwitchError,
  LMSTUDIO_LOAD_LIMIT_MS, LMSTUDIO_UNLOAD_LIMIT_MS, LMSTUDIO_UNLOAD_SETTLE_MS,
  __stopEndedLmStudioLoadWatchForTests,
} from '../lmstudio'
import { __resetEndedLmStudioLoadsForTests } from '../../lib/lmstudio-ended-loads'
import { CallTimeoutError } from '../../lib/call-limit'
import { OLLAMA_LOAD_LIMIT_MS, OLLAMA_UNLOAD_LIMIT_MS } from '../ollama'

const callsOf = (command: string) => backendCall.mock.calls.filter(([c]) => c === command)

/** A bridge whose load never answers until it is cancelled, like `lms load` on a model that does not come up. */
function bridgeThatHoldsLoads() {
  const held = new Map<unknown, (reason: string) => void>()
  backendCall.mockImplementation((command, args) => {
    if (command === 'lmstudio_load_model') {
      return new Promise((_resolve, reject) => { held.set(args?.callId, reject) })
    }
    if (command === 'lmstudio_cancel_load') {
      held.get(args?.callId)?.('lms load cancelled')
      held.delete(args?.callId)
    }
    return Promise.resolve(null)
  })
  return held
}

// What an ended load leaves behind (a-cancelled-lmstudio-load-is-unloaded.test.ts)
// is not this file's subject and must not reach the next test.
beforeEach(() => {
  backendCall.mockReset()
  __resetEndedLmStudioLoadsForTests()
})
afterEach(() => {
  __stopEndedLmStudioLoadWatchForTests()
  vi.useRealTimers()
})

describe('the limits', () => {
  it('are the ones an Ollama load and unload have', () => {
    expect(LMSTUDIO_LOAD_LIMIT_MS).toBe(OLLAMA_LOAD_LIMIT_MS)
    expect(LMSTUDIO_UNLOAD_LIMIT_MS).toBe(OLLAMA_UNLOAD_LIMIT_MS)
  })
})

describe('loading an LM Studio model', () => {
  it('hands the bridge the model, the window, a limit of its own and an id to end it by', async () => {
    backendCall.mockResolvedValue({ ok: true })

    await loadLmStudioModel('some-9b', 16384)

    const [, args] = callsOf('lmstudio_load_model')[0]
    expect(args?.model).toBe('some-9b')
    expect(args?.contextLength).toBe(16384)
    // The bridge gets a little longer, so the limit that ends the call is ours.
    expect(args?.timeoutMs).toBeGreaterThan(LMSTUDIO_LOAD_LIMIT_MS)
    expect(typeof args?.callId).toBe('string')
    expect(callsOf('lmstudio_cancel_load')).toHaveLength(0)
  })

  it('sends no window when none is asked for', async () => {
    backendCall.mockResolvedValue({ ok: true })
    await loadLmStudioModel('some-9b')
    await loadLmStudioModel('some-9b', 0)
    expect(callsOf('lmstudio_load_model').map(([, a]) => a?.contextLength)).toEqual([null, null])
  })

  it('ends at its limit: the bridge is told to stop that load, and the error says it ran out', async () => {
    vi.useFakeTimers()
    bridgeThatHoldsLoads()

    const load = loadLmStudioModel('some-9b', 16384)
    const outcome = load.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(LMSTUDIO_LOAD_LIMIT_MS - 1)
    expect(callsOf('lmstudio_cancel_load')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)

    const error = await outcome
    expect(error).toBeInstanceOf(LmStudioTimeoutError)
    expect(error).toBeInstanceOf(CallTimeoutError)
    expect((error as Error).message).toBe('Loading some-9b took longer than 5 minutes and was stopped.')
    const started = callsOf('lmstudio_load_model')[0][1]?.callId
    expect(callsOf('lmstudio_cancel_load').map(([, a]) => a?.callId)).toEqual([started])
  })

  it('ends when the caller cancels: an AbortError, and the bridge is told to stop that load', async () => {
    bridgeThatHoldsLoads()
    const cancel = new AbortController()

    const outcome = loadLmStudioModel('some-9b', 16384, { signal: cancel.signal }).catch((e: unknown) => e)
    await Promise.resolve()
    cancel.abort()

    const error = await outcome
    expect((error as Error).name).toBe('AbortError')
    expect(error).not.toBeInstanceOf(CallTimeoutError)
    const started = callsOf('lmstudio_load_model')[0][1]?.callId
    expect(callsOf('lmstudio_cancel_load').map(([, a]) => a?.callId)).toEqual([started])
  })

  it('starts nothing for a caller that cancelled before', async () => {
    const cancel = new AbortController()
    cancel.abort()

    const error = await loadLmStudioModel('some-9b', 16384, { signal: cancel.signal }).catch((e: unknown) => e)

    expect((error as Error).name).toBe('AbortError')
    expect(callsOf('lmstudio_load_model')).toHaveLength(0)
  })

  it('does not wait forever for a bridge that never reports the stopped load', async () => {
    vi.useFakeTimers()
    backendCall.mockImplementation((command) =>
      command === 'lmstudio_load_model' ? new Promise(() => {}) : Promise.resolve(null))
    const cancel = new AbortController()

    const outcome = loadLmStudioModel('some-9b', 16384, { signal: cancel.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10)
    cancel.abort()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(((await outcome) as Error).name).toBe('AbortError')
  })

  it('hands on the reason the command gave when LM Studio refuses', async () => {
    backendCall.mockRejectedValue('lms load failed: \u001b[31mError:\u001b[39m Insufficient system resources.\n  Try a smaller model.')

    const error = await loadLmStudioModel('some-9b', 16384).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LmStudioSwitchError)
    expect((error as LmStudioSwitchError).reason).toBe('Error: Insufficient system resources. Try a smaller model.')
    // Nothing was running any more, so there is nothing to stop.
    expect(callsOf('lmstudio_cancel_load')).toHaveLength(0)
  })
})

describe('unloading an LM Studio model', () => {
  it('ends at its limit', async () => {
    vi.useFakeTimers()
    backendCall.mockImplementation(() => new Promise(() => {}))

    const outcome = unloadLmStudioModel('some-9b').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(LMSTUDIO_UNLOAD_LIMIT_MS)

    const error = await outcome
    expect(error).toBeInstanceOf(LmStudioTimeoutError)
    expect((error as Error).message).toBe('LM Studio did not answer the unload of some-9b.')
    expect(callsOf('lmstudio_unload_model')[0][1]?.timeoutMs).toBeGreaterThan(LMSTUDIO_UNLOAD_LIMIT_MS)
  })

  it('says unloaded only when the model has left the loaded list', async () => {
    let listed = ['some-9b', 'other-4b']
    backendCall.mockImplementation(async (command) => {
      if (command === 'lmstudio_unload_model') { listed = ['other-4b']; return { ok: true } }
      return { loaded: listed, readable: true }
    })

    await expect(unloadLmStudioModelAndLook('some-9b')).resolves.toBe('unloaded')
  })

  it('does not call a model unloaded that LM Studio still lists', async () => {
    vi.useFakeTimers()
    backendCall.mockImplementation(async (command) =>
      command === 'lmstudio_unload_model' ? { ok: true } : { loaded: ['some-9b'], readable: true })

    const outcome = unloadLmStudioModelAndLook('some-9b')
    await vi.advanceTimersByTimeAsync(LMSTUDIO_UNLOAD_SETTLE_MS + 1_000)

    await expect(outcome).resolves.toBe('still-loaded')
  })

  it('gives a slow unload the time to land before it judges', async () => {
    vi.useFakeTimers()
    let looks = 0
    backendCall.mockImplementation(async (command) => {
      if (command === 'lmstudio_unload_model') return { ok: true }
      looks += 1
      return { loaded: looks < 3 ? ['some-9b'] : [], readable: true }
    })

    const outcome = unloadLmStudioModelAndLook('some-9b')
    await vi.advanceTimersByTimeAsync(LMSTUDIO_UNLOAD_SETTLE_MS)

    await expect(outcome).resolves.toBe('unloaded')
  })

  it('throws when the list cannot be read afterwards: nothing true can be said', async () => {
    backendCall.mockImplementation(async (command) =>
      command === 'lmstudio_unload_model' ? { ok: true } : { loaded: [], readable: false })

    await expect(unloadLmStudioModelAndLook('some-9b')).rejects.toThrow(/did not answer/)
  })
})

describe('the loaded list', () => {
  it('an unreadable list is a throw for whoever reports, and empty for the poll', async () => {
    backendCall.mockResolvedValue({ loaded: [], readable: false })
    await expect(readLoadedLmStudioModels()).rejects.toThrow()
    await expect(listLoadedLmStudioModels()).resolves.toEqual([])

    backendCall.mockRejectedValue('bridge down')
    await expect(readLoadedLmStudioModels()).rejects.toBeDefined()
    await expect(listLoadedLmStudioModels()).resolves.toEqual([])
  })

  it('a readable list is the list', async () => {
    backendCall.mockResolvedValue({ loaded: ['a', 'b'], readable: true })
    await expect(readLoadedLmStudioModels()).resolves.toEqual(['a', 'b'])
    // An older bridge that does not say whether it could read is taken at its word.
    backendCall.mockResolvedValue({ loaded: ['a'] })
    await expect(readLoadedLmStudioModels()).resolves.toEqual(['a'])
  })
})
