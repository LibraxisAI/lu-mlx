/**
 * In the app `localFetch` sends a request through the Rust proxy and, when
 * that fails, sends the same request again directly. For a model load that
 * second request was a new wait with no limit at all: the proxy gave up after
 * its 300 seconds and the load started over (found by reading, 10.10.2026,
 * after a load switch that never came back).
 *
 * `loadModel` now carries one signal for the whole call. These tests run the
 * real `localFetch` in app mode and pin the chain: at the limit, and on the
 * caller's cancel, the proxy call is cancelled by its id and no second request
 * goes out.
 *
 * Run: npx vitest run src/api/__tests__/an-ollama-load-is-not-sent-twice.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { loadModel, OllamaTimeoutError, OLLAMA_LOAD_LIMIT_MS } from '../ollama'
import { useSettingsStore } from '../../stores/settingsStore'
import { isRecord } from '../../types/json-guards'

const fetchMock = vi.fn()

function tauriMode(on: boolean) {
  const existing: unknown = Reflect.get(globalThis, 'window')
  const w: Record<string, unknown> = isRecord(existing) ? existing : {}
  Reflect.set(globalThis, 'window', w)
  if (on) w.__TAURI_INTERNALS__ = {}
  else { delete w.__TAURI_INTERNALS__; delete w.__TAURI__ }
}

/** The proxy holds the load, like Ollama behind a busy model, and answers a cancel the way Rust does. */
function proxyHoldsTheLoad() {
  const rejectors = new Map<string, (reason: unknown) => void>()
  invokeMock.mockImplementation((cmd: string, args: { callId: string }) => {
    if (cmd === 'proxy_localhost') {
      return new Promise<string>((_resolve, reject) => { rejectors.set(args.callId, reject) })
    }
    if (cmd === 'cancel_proxy_call') {
      rejectors.get(args.callId)?.('proxy_localhost: cancelled')
      return Promise.resolve()
    }
    throw new Error(`unexpected invoke: ${cmd}`)
  })
}

const calls = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  tauriMode(true)
  // An override, so the load asks nothing before the load itself.
  useSettingsStore.getState().updateSettings({ contextWindowOverride: 8192 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  tauriMode(false)
  useSettingsStore.getState().updateSettings({ contextWindowOverride: 0 })
})

describe('a model load in the app', () => {
  it('at its limit cancels the proxy call and sends no second request', async () => {
    vi.useFakeTimers()
    proxyHoldsTheLoad()

    const outcome = loadModel('some-9b').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(OLLAMA_LOAD_LIMIT_MS)

    expect(await outcome).toBeInstanceOf(OllamaTimeoutError)
    expect(calls('proxy_localhost')).toHaveLength(1)
    const sent = calls('proxy_localhost')[0][1] as { callId: string; timeoutMs: number }
    expect((calls('cancel_proxy_call')[0][1] as { callId: string }).callId).toBe(sent.callId)
    // The proxy's own clock runs longer than ours, so ours is the one limit.
    expect(sent.timeoutMs).toBeGreaterThan(OLLAMA_LOAD_LIMIT_MS)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('on the caller\'s cancel does the same, at once', async () => {
    proxyHoldsTheLoad()
    const cancel = new AbortController()

    const outcome = loadModel('some-9b', { signal: cancel.signal }).catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls('proxy_localhost')).toHaveLength(1)
    cancel.abort()

    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(calls('cancel_proxy_call')).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a proxy command failure still gets its one direct try, under the same signal', async () => {
    // Dead loopback sockets stop at 503 (local-fetch-unreachable.test.ts);
    // a proxy-layer failure still falls back to a direct fetch with the same signal.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'proxy_localhost' ? Promise.reject('proxy command unavailable') : Promise.resolve())
    fetchMock.mockResolvedValue(new Response('{"done":true}', { status: 200 }))

    await loadModel('some-9b')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal }
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
