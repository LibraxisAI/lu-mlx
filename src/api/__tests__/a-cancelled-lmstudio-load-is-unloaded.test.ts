import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Cancel means the model is not in LM Studio afterwards.
 *
 * Hand test on Windows, 11.10.2026, LM Studio 0.4.12: a 6 GB model, its load
 * cancelled after 1.2 s and after 7 s. The `lms load` process was gone within
 * half a second both times. LM Studio went on: `loading` for another 26 to
 * 46 s, then `loaded`, 10.8 GB of graphics memory taken, the picker on "Off".
 *
 * Second hand test the same day, on the first version of this fix: `lms unload`
 * of a model that is still loading ends that load within half a second, also
 * when the `lms load` that asked for it was killed 2.2 s before. So the app
 * sends one unload as soon as it sees the ended load as `loading`, and does
 * not wait 41 s for 8 GB to arrive only to unload them.
 *
 * The stand-in below is an LM Studio that finishes a load it began whether or
 * not the command that asked for it is still there. Whether an unload ends a
 * load in mid-flight is a switch: on is what 0.4.12 does, off is the version
 * the net behind the early unload is for.
 *
 * The rules, one test each:
 *   - a cancelled load is ended by one unload while LM Studio is still loading
 *   - when LM Studio does not take that unload, the model is unloaded once it
 *     is reported loaded, and the early unload is not sent a second time
 *   - an early unload that fails says nothing and the watch goes on
 *   - so does a load that ran into its time limit
 *   - a load LM Studio begins a moment after the cancel is still caught
 *   - a load that never reached LM Studio is seen to be gone, not waited for forever
 *   - what somebody else loaded is never unloaded
 *   - asking for the same model again keeps it: an unload on its way is waited
 *     for, a load LM Studio is still on is not asked for twice
 *   - loading another model, and switching the chat to another backend, change nothing
 *   - an unload that did not take is asked again
 *   - an LM Studio that stops answering is given up on at a limit, and that is said
 *   - nothing is asked while no load is ended
 *
 * Quitting the app while a load is ended has no test: the list dies with the
 * app and the model stays loaded in LM Studio.
 *
 * Run: npx vitest run src/api/__tests__/a-cancelled-lmstudio-load-is-unloaded.test.ts
 */

type Args = Record<string, unknown> | undefined
const backendCall = vi.fn(async (_command: string, _args?: Args): Promise<unknown> => ({}))

vi.mock('../backend', () => ({
  backendCall: (command: string, args?: Args) => backendCall(command, args),
}))

import {
  loadLmStudioModel, LmStudioTimeoutError, __stopEndedLmStudioLoadWatchForTests,
  LMSTUDIO_LOAD_LIMIT_MS, LMSTUDIO_ENDED_LOAD_LOOK_MS, LMSTUDIO_ENDED_LOAD_QUIET_MS, LMSTUDIO_ENDED_LOAD_WATCH_LIMIT_MS,
} from '../lmstudio'
import {
  endedLmStudioLoads, endedLmStudioLoadsViewForTests, lmStudioGoneMark, lmStudioWentAfter,
  __resetEndedLmStudioLoadsForTests,
} from '../../lib/lmstudio-ended-loads'
import { useProviderStore } from '../../stores/providerStore'

const callsOf = (command: string) => backendCall.mock.calls.filter(([c]) => c === command)
const ending = () => endedLmStudioLoads().map((e) => e.model)

interface FakeLmStudio {
  state: Map<string, 'loading' | 'loaded'>
  /** How many times each model sits in memory or is on its way there. */
  instances: Map<string, number>
  answers: boolean
  /** Models whose unload is answered and that stay loaded. */
  keeps: Set<string>
  /** A cancel that arrives before LM Studio took the load ends it for real. */
  cancelBeatsTheLoad: boolean
  /** An unload of a model that is still loading ends the load (LM Studio 0.4.12). */
  unloadEndsLoads: boolean
  /** How long LM Studio takes to answer an unload. */
  unloadTakesMs: number
  /** An unload of a model that is not loaded is refused, like `lms unload` of an unknown identifier. */
  refusesUnloadOfLoading: boolean
  /** How long after it was asked LM Studio first reports a load as `loading`. */
  showsLoadingAfterMs: number
}

/** An LM Studio that finishes a load it began, `loadTakesMs` after it was asked. */
function fakeLmStudio(loadTakesMs: number, preloaded: string[] = []): FakeLmStudio {
  const lm: FakeLmStudio = {
    state: new Map(preloaded.map((m) => [m, 'loaded' as const])),
    instances: new Map(preloaded.map((m) => [m, 1])),
    answers: true,
    keeps: new Set(),
    cancelBeatsTheLoad: false,
    unloadEndsLoads: false,
    unloadTakesMs: 0,
    refusesUnloadOfLoading: false,
    showsLoadingAfterMs: 0,
  }
  const held = new Map<unknown, { reject: (reason: string) => void; model: string }>()
  // Loads LM Studio has taken and does not report yet.
  const hidden = new Set<string>()
  // The load each model is on, so a load that was ended does not arrive later.
  const underWay = new Map<string, object>()
  const unload = (model: string) => {
    const state = lm.state.get(model)
    if (lm.keeps.has(model)) return
    if (state === 'loaded' || (state === 'loading' && lm.unloadEndsLoads)) {
      lm.state.delete(model)
      lm.instances.delete(model)
      underWay.delete(model)
    }
  }
  backendCall.mockImplementation((command, args) => {
    const model = args?.model as string
    switch (command) {
      case 'lmstudio_load_model':
        // The bridge unloads first when a window is asked for.
        if (args?.contextLength != null) unload(model)
        lm.instances.set(model, (lm.instances.get(model) ?? 0) + 1)
        lm.state.set(model, lm.state.get(model) ?? 'loading')
        if (lm.showsLoadingAfterMs > 0) {
          hidden.add(model)
          setTimeout(() => hidden.delete(model), lm.showsLoadingAfterMs)
        }
        return new Promise((resolve, reject) => {
          const load = {}
          if (!underWay.has(model)) underWay.set(model, load)
          held.set(args?.callId, { reject, model })
          setTimeout(() => {
            if (underWay.get(model) !== load || lm.state.get(model) !== 'loading') return
            lm.state.set(model, 'loaded')
            resolve({ ok: true })
          }, loadTakesMs)
        })
      case 'lmstudio_cancel_load': {
        // The `lms` process dies. LM Studio keeps loading.
        const load = held.get(args?.callId)
        held.delete(args?.callId)
        if (load && lm.cancelBeatsTheLoad) {
          lm.state.delete(load.model)
          lm.instances.delete(load.model)
          underWay.delete(load.model)
        }
        load?.reject('lms load cancelled')
        return Promise.resolve(null)
      }
      case 'lmstudio_unload_model':
        return new Promise((resolve, reject) => setTimeout(() => {
          if (lm.refusesUnloadOfLoading && lm.state.get(model) !== 'loaded') {
            reject('lms unload failed: Cannot find a model with the identifier')
            return
          }
          unload(model)
          resolve({ ok: true })
        }, lm.unloadTakesMs))
      case 'lmstudio_list_loaded':
        return Promise.resolve(lm.answers
          ? { loaded: [...lm.state].filter(([, s]) => s === 'loaded').map(([m]) => m), readable: true }
          : { loaded: [], readable: false })
      case 'lmstudio_model_context':
        return Promise.resolve({
          loaded: null,
          max: null,
          state: !lm.answers ? null : hidden.has(model) ? 'not-loaded' : lm.state.get(model) ?? 'not-loaded',
        })
      default:
        return Promise.resolve(null)
    }
  })
  return lm
}

/** Start a load and cancel it `afterMs` later. Resolves when the call has ended. */
async function loadAndCancel(model: string, afterMs: number, contextLength: number = 16384) {
  const cancel = new AbortController()
  const outcome = loadLmStudioModel(model, contextLength, { signal: cancel.signal }).catch((e: unknown) => e)
  await vi.advanceTimersByTimeAsync(afterMs)
  cancel.abort()
  await vi.advanceTimersByTimeAsync(0)
  return outcome
}

beforeEach(() => {
  vi.useFakeTimers()
  backendCall.mockReset()
  __resetEndedLmStudioLoadsForTests()
})
afterEach(() => {
  __stopEndedLmStudioLoadWatchForTests()
  vi.useRealTimers()
})

const unloadsOf = (model: string) => callsOf('lmstudio_unload_model').filter(([, a]) => a?.model === model).length

describe('a load that was cancelled while LM Studio goes on loading', () => {
  it('is ended by one unload at once, and nothing is waited for', async () => {
    const lm = fakeLmStudio(40_000)
    lm.unloadEndsLoads = true
    lm.unloadTakesMs = 500
    const error = await loadAndCancel('vl-7b', 3_000)
    expect((error as Error).name).toBe('AbortError')

    // The command is gone, LM Studio still loads, and the unload is on its way.
    expect(ending()).toEqual(['vl-7b'])
    expect(unloadsOf('vl-7b')).toBe(1)

    await vi.advanceTimersByTimeAsync(600)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])

    // It stays that way, and nothing more is asked.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(unloadsOf('vl-7b')).toBe(1)
  })

  it('is unloaded once LM Studio reports it loaded when the early unload changed nothing, and is cancelling until then', async () => {
    const lm = fakeLmStudio(30_000)
    await loadAndCancel('vl-7b', 1_200)

    // The early unload was answered and LM Studio is still loading: the
    // model is not called off, and the unload is not sent again and again.
    expect(lm.state.get('vl-7b')).toBe('loading')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ending()).toEqual(['vl-7b'])
    expect(unloadsOf('vl-7b')).toBe(1)

    // LM Studio finishes the load at 30 s. The next look unloads it.
    await vi.advanceTimersByTimeAsync(10_000 + LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(unloadsOf('vl-7b')).toBe(2)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])
  })

  it('goes on watching without a word when the early unload is refused', async () => {
    const lm = fakeLmStudio(10_000)
    lm.refusesUnloadOfLoading = true
    await loadAndCancel('vl-7b', 1_200)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ending()).toEqual(['vl-7b'])
    expect(endedLmStudioLoadsViewForTests().unconfirmed).toEqual([])

    await vi.advanceTimersByTimeAsync(5_000 + LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])
    expect(unloadsOf('vl-7b')).toBe(2)
  })

  it('is unloaded as well when it was the time limit that ended it', async () => {
    const lm = fakeLmStudio(LMSTUDIO_LOAD_LIMIT_MS + 20_000)
    const outcome = loadLmStudioModel('vl-7b', 16384).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(LMSTUDIO_LOAD_LIMIT_MS)
    expect(await outcome).toBeInstanceOf(LmStudioTimeoutError)
    expect(ending()).toEqual(['vl-7b'])

    await vi.advanceTimersByTimeAsync(20_000 + LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])
  })

  it('asks the unload again when the model is still listed afterwards', async () => {
    const lm = fakeLmStudio(5_000)
    lm.keeps.add('vl-7b')
    await loadAndCancel('vl-7b', 1_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(unloadsOf('vl-7b')).toBeGreaterThan(2)
    expect(ending()).toEqual(['vl-7b'])

    lm.keeps.clear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])
  })
})

describe('a load that was cancelled before LM Studio reported it', () => {
  it('is seen to be gone after a few quiet looks, without an unload, when LM Studio never began it', async () => {
    const lm = fakeLmStudio(30_000)
    lm.cancelBeatsTheLoad = true
    await loadAndCancel('vl-7b', 100)
    expect(ending()).toEqual(['vl-7b'])

    await vi.advanceTimersByTimeAsync(LMSTUDIO_ENDED_LOAD_QUIET_MS - 100)
    expect(ending()).toEqual(['vl-7b'])
    await vi.advanceTimersByTimeAsync(100 + LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(ending()).toEqual([])
    expect(callsOf('lmstudio_unload_model')).toHaveLength(0)
  })

  it('is still caught when LM Studio begins it a moment after the command was gone', async () => {
    const lm = fakeLmStudio(40_000)
    lm.unloadEndsLoads = true
    // LM Studio has the request and reports nothing for 2.5 s.
    lm.showsLoadingAfterMs = 2_500
    await loadAndCancel('vl-7b', 300)
    expect(unloadsOf('vl-7b')).toBe(0)

    // Looks at once and after one beat find nothing; the third finds it.
    await vi.advanceTimersByTimeAsync(LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(ending()).toEqual(['vl-7b'])
    await vi.advanceTimersByTimeAsync(LMSTUDIO_ENDED_LOAD_LOOK_MS + 100)
    expect(unloadsOf('vl-7b')).toBe(1)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])
  })
})

describe('what LU did not load', () => {
  it('is not unloaded: another model that sits in LM Studio stays', async () => {
    const lm = fakeLmStudio(10_000, ['their-own-9b'])
    await loadAndCancel('vl-7b', 1_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(lm.state.get('their-own-9b')).toBe('loaded')
    expect(unloadsOf('their-own-9b')).toBe(0)
  })

  it('is not unloaded: a plain load of a model that was already loaded is not LU\'s', async () => {
    const lm = fakeLmStudio(10_000, ['vl-7b'])
    await loadAndCancel('vl-7b', 1_000, 0)
    expect(ending()).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(lm.state.get('vl-7b')).toBe('loaded')
    expect(callsOf('lmstudio_unload_model')).toHaveLength(0)
  })

  it('control: a plain load of a model that was not loaded is LU\'s, and is unloaded', async () => {
    const lm = fakeLmStudio(10_000)
    await loadAndCancel('vl-7b', 1_000, 0)
    expect(ending()).toEqual(['vl-7b'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(lm.state.has('vl-7b')).toBe(false)
  })

  it('is not unloaded: a plain load behind a list that could not be read is not LU\'s', async () => {
    const lm = fakeLmStudio(10_000)
    lm.answers = false
    await loadAndCancel('vl-7b', 1_000, 0)
    expect(ending()).toEqual([])
  })
})

describe('asking for the same model again while its ended load is still under way', () => {
  it('keeps the model: no second load is started and nothing is unloaded', async () => {
    const lm = fakeLmStudio(30_000)
    await loadAndCancel('vl-7b', 1_200)
    await vi.advanceTimersByTimeAsync(5_000)

    let done = false
    const again = loadLmStudioModel('vl-7b', 16384).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    // Off the list at once: what is wanted now outranks the cancel.
    expect(ending()).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(20_000)
    await again
    expect(lm.state.get('vl-7b')).toBe('loaded')
    expect(lm.instances.get('vl-7b')).toBe(1)
    expect(callsOf('lmstudio_load_model')).toHaveLength(1)
    // The one early unload went out before the model was asked for again.
    // Nothing is unloaded after that.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(unloadsOf('vl-7b')).toBe(1)
    expect(lm.state.get('vl-7b')).toBe('loaded')
  })

  it('waits for an unload that is on its way before it asks for the load, so the unload cannot hit it', async () => {
    const lm = fakeLmStudio(10_000)
    lm.unloadEndsLoads = true
    lm.unloadTakesMs = 800
    await loadAndCancel('vl-7b', 3_000)
    expect(unloadsOf('vl-7b')).toBe(1)

    // Asked for again 100 ms later, while the unload is still out.
    await vi.advanceTimersByTimeAsync(100)
    const again = loadLmStudioModel('vl-7b', 16384)
    await vi.advanceTimersByTimeAsync(500)
    expect(callsOf('lmstudio_load_model')).toHaveLength(1)
    expect(ending()).toEqual([])

    // The unload landed and ended the old load. Now the new one is asked for.
    await vi.advanceTimersByTimeAsync(500)
    expect(callsOf('lmstudio_load_model')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10_000)
    await again
    expect(lm.state.get('vl-7b')).toBe('loaded')
    expect(lm.instances.get('vl-7b')).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(lm.state.get('vl-7b')).toBe('loaded')
    expect(unloadsOf('vl-7b')).toBe(1)
  })

  it('after the early unload ended the load is a load like any other', async () => {
    const lm = fakeLmStudio(10_000)
    lm.unloadEndsLoads = true
    await loadAndCancel('vl-7b', 3_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ending()).toEqual([])

    const again = loadLmStudioModel('vl-7b', 16384)
    await vi.advanceTimersByTimeAsync(10_000)
    await again
    expect(callsOf('lmstudio_load_model')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lm.state.get('vl-7b')).toBe('loaded')
  })

  it('and cancelling that too ends in an unloaded model', async () => {
    const lm = fakeLmStudio(30_000)
    await loadAndCancel('vl-7b', 1_200)
    const error = await loadAndCancel('vl-7b', 3_000)
    expect((error as Error).name).toBe('AbortError')
    expect(ending()).toEqual(['vl-7b'])
    await vi.advanceTimersByTimeAsync(40_000)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(callsOf('lmstudio_load_model')).toHaveLength(1)
  })

  it('with another window is a load of its own', async () => {
    fakeLmStudio(30_000)
    await loadAndCancel('vl-7b', 1_200)
    void loadLmStudioModel('vl-7b', 8192).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    expect(callsOf('lmstudio_load_model').map(([, a]) => a?.contextLength)).toEqual([16384, 8192])
    expect(ending()).toEqual([])
  })
})

describe('what does not change an ended load', () => {
  it('loading another model: that one stays, the cancelled one goes', async () => {
    const lm = fakeLmStudio(20_000)
    await loadAndCancel('vl-7b', 1_200)
    const other = loadLmStudioModel('other-4b', 16384)
    await vi.advanceTimersByTimeAsync(30_000)
    await other
    expect(lm.state.get('other-4b')).toBe('loaded')
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(unloadsOf('other-4b')).toBe(0)
  })

  it('handing the chat to another backend: the memory is still freed', async () => {
    const lm = fakeLmStudio(20_000)
    await loadAndCancel('vl-7b', 1_200)
    const { providers } = useProviderStore.getState()
    useProviderStore.setState({ providers: { ...providers, openai: { ...providers.openai, enabled: false } } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(lm.state.has('vl-7b')).toBe(false)
    expect(ending()).toEqual([])
  })
})

describe('a loaded list that is older than the unload', () => {
  it('is known as such: the model went after the list was asked for', async () => {
    const lm = fakeLmStudio(5_000)
    await loadAndCancel('vl-7b', 1_000)
    await vi.advanceTimersByTimeAsync(4_200)
    // The picker asks while the model sits in memory, and is answered "loaded".
    expect(lm.state.get('vl-7b')).toBe('loaded')
    const asked = lmStudioGoneMark()

    await vi.advanceTimersByTimeAsync(LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(ending()).toEqual([])
    expect(lmStudioWentAfter('vl-7b', asked)).toBe(true)
    // A list asked for from now on is newer, and so is one about another model.
    expect(lmStudioWentAfter('vl-7b', lmStudioGoneMark())).toBe(false)
    expect(lmStudioWentAfter('other-4b', asked)).toBe(false)
  })

  it('is not what a model is that was asked for again: that one never went', async () => {
    fakeLmStudio(5_000)
    await loadAndCancel('vl-7b', 1_000)
    const asked = lmStudioGoneMark()
    const again = loadLmStudioModel('vl-7b', 16384)
    await vi.advanceTimersByTimeAsync(10_000)
    await again
    expect(lmStudioWentAfter('vl-7b', asked)).toBe(false)
  })
})

describe('the watch', () => {
  it('gives up at its limit when LM Studio stops answering, and says which model it could not confirm', async () => {
    const lm = fakeLmStudio(30_000)
    lm.answers = false
    await loadAndCancel('vl-7b', 1_200)
    await vi.advanceTimersByTimeAsync(LMSTUDIO_ENDED_LOAD_WATCH_LIMIT_MS - 10_000)
    expect(ending()).toEqual(['vl-7b'])
    await vi.advanceTimersByTimeAsync(10_000 + LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(ending()).toEqual([])
    expect(callsOf('lmstudio_unload_model')).toHaveLength(0)
    expect(endedLmStudioLoadsViewForTests().unconfirmed).toEqual(['vl-7b'])
  })

  it('asks LM Studio nothing while no load is ended, before or after', async () => {
    fakeLmStudio(5_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backendCall).not.toHaveBeenCalled()

    await loadAndCancel('vl-7b', 1_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ending()).toEqual([])
    const asked = backendCall.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(backendCall.mock.calls.length).toBe(asked)
  })

  it('looks once per beat, not in a loop', async () => {
    fakeLmStudio(60_000)
    await loadAndCancel('vl-7b', 1_000)
    await vi.advanceTimersByTimeAsync(100)
    const before = callsOf('lmstudio_model_context').length
    await vi.advanceTimersByTimeAsync(10 * LMSTUDIO_ENDED_LOAD_LOOK_MS)
    expect(callsOf('lmstudio_model_context').length - before).toBe(10)
  })
})
