import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Probe, 10.10.2026 (the owner, Mac hand test of 3.0.6): the load switch on a
 * model row span for as long as he watched.
 *
 * `loadModel` is one POST /api/generate with `stream: false`, and Ollama
 * answers it only once the weights are resident. When another model is busy
 * and has to be evicted first, Ollama holds the request until that model is
 * idle. The call carries neither a signal nor a time limit, so the row switch
 * in the picker, which awaits it, has no way to stop and no moment at which it
 * gives up: the Rust proxy runs its 300 s default, and when that fails
 * `localFetch` sends the same request a second time directly, with no limit
 * at all.
 *
 * And the other half: `unloadModel` returns 200 in two milliseconds while the
 * model is busy (Ollama marks it to expire after the running request), so
 * "Unload all models" wrote "Unloaded" four times over a model that stayed
 * loaded. Whoever unloads has to look at /api/ps afterwards.
 *
 * Run: npx vitest run src/api/__tests__/an-ollama-load-has-an-end.test.ts
 */

interface FetchOptions { method?: string; body?: string; signal?: AbortSignal; timeoutMs?: number }
const localFetch = vi.fn(async (_url: string, _options?: FetchOptions) =>
  new Response('{}', { status: 200 }))

vi.mock('../backend', () => ({
  ollamaUrl: (path: string) => `http://127.0.0.1:11434/api${path}`,
  localFetch: (url: string, options?: FetchOptions) => localFetch(url, options),
  localFetchStream: vi.fn(),
  isTauri: () => true,
}))

import {
  loadModel, unloadModel, unloadModelAndLook, unloadAllModels, modelsAheadOfLoad,
  OllamaTimeoutError, OLLAMA_LOAD_LIMIT_MS, OLLAMA_UNLOAD_SETTLE_MS,
} from '../ollama'

beforeEach(() => { localFetch.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('loading an Ollama model', () => {
  it('can be stopped or runs out: the request carries a signal or a time limit', async () => {
    localFetch.mockResolvedValue(new Response('{}', { status: 200 }))

    await loadModel('some-9b')

    const load = localFetch.mock.calls.find(([url]) => url.endsWith('/generate'))
    expect(load).toBeDefined()
    const options = load?.[1]
    const bounded = options?.signal instanceof AbortSignal
      || (typeof options?.timeoutMs === 'number' && options.timeoutMs > 0)
    expect(bounded).toBe(true)
  })
})

describe('Unload all models', () => {
  // Adapted from the probe, which expected a count of 0: the button has to
  // name what stayed, so the result lists both sides instead of counting one.
  it('does not count a model that is still in /api/ps afterwards', async () => {
    vi.useFakeTimers()
    // A busy model: Ollama says 200 to the unload and keeps it loaded.
    localFetch.mockImplementation(async (url: string) =>
      url.endsWith('/ps')
        ? new Response(JSON.stringify({ models: [{ name: 'busy-27b' }] }), { status: 200 })
        : new Response('{"done_reason":"unload"}', { status: 200 }))

    const pending = unloadAllModels()
    await vi.advanceTimersByTimeAsync(OLLAMA_UNLOAD_SETTLE_MS + 1000)
    const result = await pending

    expect(result.unloaded).toEqual([])
    expect(result.stillBusy).toEqual(['busy-27b'])
    expect(result.failed).toEqual([])
  })

  it('counts a model that left /api/ps, and gives an idle one a moment to leave', async () => {
    vi.useFakeTimers()
    let looks = 0
    localFetch.mockImplementation(async (url: string) => {
      if (!url.endsWith('/ps')) return new Response('{"done_reason":"unload"}', { status: 200 })
      looks += 1
      // Listed before the unload and on the first look after it, then gone.
      return new Response(JSON.stringify({ models: looks <= 2 ? [{ name: 'idle-9b' }] : [] }), { status: 200 })
    })

    const pending = unloadAllModels()
    await vi.advanceTimersByTimeAsync(OLLAMA_UNLOAD_SETTLE_MS + 1000)

    expect(await pending).toEqual({ unloaded: ['idle-9b'], stillBusy: [], failed: [] })
  })

  it('keeps a refused unload apart from a busy model', async () => {
    // The error path loads this module on demand; a module load does not
    // finish under fake timers, so it is loaded before they start.
    await import('../../lib/ollama-errors')
    vi.useFakeTimers()
    localFetch.mockImplementation(async (url: string, options?: FetchOptions) => {
      if (url.endsWith('/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'busy-27b' }, { name: 'refused-9b' }] }), { status: 200 })
      }
      return String(options?.body).includes('refused-9b')
        ? new Response('{"error":"no"}', { status: 500 })
        : new Response('{"done_reason":"unload"}', { status: 200 })
    })

    const pending = unloadAllModels()
    await vi.advanceTimersByTimeAsync(OLLAMA_UNLOAD_SETTLE_MS + 1000)

    expect(await pending).toEqual({ unloaded: [], stillBusy: ['busy-27b'], failed: ['refused-9b'] })
  })

  it('throws instead of reporting success when /api/ps cannot be read', async () => {
    localFetch.mockImplementation(async () => new Response('{"error":"down"}', { status: 500 }))
    await expect(unloadAllModels()).rejects.toThrow(/did not report/)
  })
})

describe('unloading one model', () => {
  it('says busy while the model is still listed and unloaded once it is not', async () => {
    vi.useFakeTimers()
    let listed = true
    localFetch.mockImplementation(async (url: string) =>
      url.endsWith('/ps')
        ? new Response(JSON.stringify({ models: listed ? [{ name: 'some-27b' }] : [] }), { status: 200 })
        : new Response('{"done_reason":"unload"}', { status: 200 }))

    const busy = unloadModelAndLook('some-27b')
    await vi.advanceTimersByTimeAsync(OLLAMA_UNLOAD_SETTLE_MS + 1000)
    expect(await busy).toBe('busy')

    listed = false
    expect(await unloadModelAndLook('some-27b')).toBe('unloaded')
  })

  it('carries a signal too', async () => {
    localFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    await unloadModel('some-9b')
    expect(localFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('a load that Ollama holds back', () => {
  /** Never answers; rejects like the real transport when its signal aborts. */
  const held = (_url: string, options?: FetchOptions) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })

  it('ends at its limit with a sentence for the screen, and the request is closed', async () => {
    vi.useFakeTimers()
    localFetch.mockImplementation(held)

    const pending = loadModel('some-9b')
    const outcome = pending.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(OLLAMA_LOAD_LIMIT_MS)

    const error = await outcome
    expect(error).toBeInstanceOf(OllamaTimeoutError)
    expect((error as Error).message).toBe('Loading some-9b took longer than 5 minutes and was stopped.')
    const load = localFetch.mock.calls.find(([url]) => url.endsWith('/generate'))
    expect(load?.[1]?.signal?.aborted).toBe(true)
  })

  it('ends at once when the caller cancels, as an abort and not as a timeout', async () => {
    localFetch.mockImplementation(held)
    const cancel = new AbortController()

    const outcome = loadModel('some-9b', { signal: cancel.signal }).catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 0))
    cancel.abort()

    const error = await outcome
    expect(error).not.toBeInstanceOf(OllamaTimeoutError)
    expect((error as Error).name).toBe('AbortError')
    const load = localFetch.mock.calls.find(([url]) => url.endsWith('/generate'))
    expect(load?.[1]?.signal?.aborted).toBe(true)
  })

  it('tells the proxy to wait longer than our own limit, so there is one limit and not two', async () => {
    localFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    await loadModel('some-9b')
    const load = localFetch.mock.calls.find(([url]) => url.endsWith('/generate'))
    expect(load?.[1]?.timeoutMs).toBeGreaterThan(OLLAMA_LOAD_LIMIT_MS)
  })
})

describe('what a pending load is waiting behind', () => {
  const ps = (names: string[]) => async () =>
    new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 })

  it('names the other loaded models while the new one is not listed yet', async () => {
    localFetch.mockImplementation(ps(['busy-27b']))
    expect(await modelsAheadOfLoad('some-9b')).toEqual(['busy-27b'])
  })

  it('names nobody once the new model is listed: it is loading', async () => {
    localFetch.mockImplementation(ps(['busy-27b', 'some-9b']))
    expect(await modelsAheadOfLoad('some-9b')).toEqual([])
  })

  it('names nobody when nothing is loaded', async () => {
    localFetch.mockImplementation(ps([]))
    expect(await modelsAheadOfLoad('some-9b')).toEqual([])
  })
})
