/**
 * A down local backend used to fail twice: the Rust proxy, then a direct
 * webview fetch that the console printed as "Could not connect to the server"
 * (built-in engine on 127.0.0.1:8127, KoboldCpp on localhost:5001, and every
 * other discovery probe). The proxy already knows the socket is dead. Do not
 * ask the webview to rediscover that.
 *
 * Run: npx vitest run src/api/__tests__/local-fetch-unreachable.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { ensureProxyAllowsHost, localFetch, unusableBackendTarget } from '../backend'
import { isRecord } from '../../types/json-guards'

const fetchMock = vi.fn()

function tauriMode(on: boolean) {
  const existing: unknown = Reflect.get(globalThis, 'window')
  const w: Record<string, unknown> = isRecord(existing) ? existing : {}
  Reflect.set(globalThis, 'window', w)
  if (on) w.__TAURI_INTERNALS__ = {}
  else { delete w.__TAURI_INTERNALS__; delete w.__TAURI__ }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  tauriMode(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  tauriMode(false)
})

describe('localFetch does not double-fail a dead loopback backend', () => {
  it('returns 503 for a refused 8127 without a direct fetch', async () => {
    invokeMock.mockRejectedValue(
      'proxy_localhost: error sending request for url (http://127.0.0.1:8127/v1/models)',
    )
    const res = await localFetch('http://127.0.0.1:8127/v1/models', { timeoutMs: 2000 })
    expect(res.status).toBe(503)
    expect(res.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 for a refused 5001 without a direct fetch', async () => {
    invokeMock.mockRejectedValue(
      'proxy_localhost: error sending request for url (http://localhost:5001/v1/models)',
    )
    const res = await localFetch('http://localhost:5001/v1/models')
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still returns the proxy body when the backend is up', async () => {
    invokeMock.mockResolvedValue('{"data":[{"id":"live"}]}')
    const res = await localFetch('http://127.0.0.1:8127/v1/models')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('live')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still falls through to a direct fetch for a non-connect proxy failure', async () => {
    invokeMock.mockRejectedValue('proxy command panicked')
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const res = await localFetch('http://127.0.0.1:8188/system_stats')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('localFetch does not probe a half-typed host', () => {
  const garbage = [
    'models',
    '/models',
    '',
    'http:///models',
    'http://models/',
    'http://1/models',
    'http://12/models',
    'http://127/models',
    'http://0.0.0.1/models',
    'http://0.0.0.12/models',
    'http://0.0.0.127/models',
    'http://127.0/models',
    'http://127.0.0.0/models',
  ]

  it.each(garbage)('refuses %s before the proxy and before fetch', async (url) => {
    const res = await localFetch(url)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still proxies a real loopback address, including the 127.1 shorthand and 0.0.0.0', async () => {
    invokeMock.mockResolvedValue('{"ok":true}')
    for (const url of [
      'http://127.0.0.1:8127/v1/models',
      'http://127.1:8127/v1/models',
      'http://localhost:11434/api/tags',
      'http://0.0.0.0:11434/api/tags',
    ]) {
      invokeMock.mockClear()
      const res = await localFetch(url)
      expect(res.status).toBe(200)
      expect(invokeMock).toHaveBeenCalled()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the proxy refusal without a direct webview fetch', async () => {
    invokeMock.mockRejectedValue("refused: '8.8.8.8' is not a usable backend host")
    const res = await localFetch('http://8.8.8.8:1234/v1/models')
    expect(res.status).toBe(400)
    expect(res.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not register a half-typed host with the proxy', async () => {
    await ensureProxyAllowsHost('http://1')
    await ensureProxyAllowsHost('http:///models')
    await ensureProxyAllowsHost('http://127.0.0.0')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('names the keystroke collapses', () => {
    expect(unusableBackendTarget('http://1/models')).toBe('incomplete IPv4')
    expect(unusableBackendTarget('http://12/models')).toBe('incomplete IPv4')
    expect(unusableBackendTarget('http://127/models')).toBe('incomplete IPv4')
    expect(unusableBackendTarget('http://127.0/models')).toBe('unusable loopback network address')
    expect(unusableBackendTarget('http:///models')).toBe('path segment used as host')
    expect(unusableBackendTarget('models')).toBe('relative URL without a base')
    expect(unusableBackendTarget('http://127.0.0.1:8127/v1/models')).toBeNull()
    expect(unusableBackendTarget('http://0.0.0.0:11434/')).toBeNull()
  })

  it('still fetches a Vite-relative path outside Tauri', async () => {
    tauriMode(false)
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const res = await localFetch('/api/tags')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
