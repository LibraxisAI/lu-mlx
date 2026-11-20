/**
 * K8 (GH #134, `npm run dev --host`): a deliberately LAN-exposed
 * dev server rejected its own onboarding write requests: the page loaded
 * from the machine's LAN IP (e.g. `http://192.168.1.23:5273`), which is
 * neither `tauri://localhost` nor the loopback regex, so the guard's Origin
 * check 403'd it with "Invalid Origin (CSRF Protection)" exactly as it
 * would a real cross-origin page.
 *
 * The fix (dev-server/guard.ts) adds a SECOND, optional parameter to
 * createLocalApiGuard: a per-request getter for the server's own resolved
 * LAN origin(s), supplied by dev-server/index.ts only when `--host` is
 * active. Nothing here weakens the DNS-rebinding protection the guard
 * already had (waechter-und-port.test.ts): a value the CALLER supplies
 * (Origin, Host) still never authorises anything; only a value the SERVER
 * computed about its own bind address can.
 *
 * Run: npx vitest run dev-server/__tests__/lan-origin-k8.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createLocalApiGuard } from '../guard'
import { lanOrigins } from '../index'
import { anfrage } from './echte-anfrage'

const csrf = { 'x-locally-uncensored': 'true' }
const json = { 'Content-Type': 'application/json', ...csrf }
const DURCHGEREICHT = 599

describe('K8 (--host): the server accepts its own LAN origin', () => {
  it('without a getLanOrigins getter (plain `npm run dev`), a LAN origin is still rejected', async () => {
    const waechter = createLocalApiGuard(5273)
    const res = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'http://192.168.1.23:5273' }, body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('with getLanOrigins active, the exact resolved LAN origin is accepted', async () => {
    const waechter = createLocalApiGuard(5273, () => ['http://192.168.1.23:5273'])
    const res = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'http://192.168.1.23:5273' }, body: '{}',
    })
    expect(res.status).toBe(DURCHGEREICHT)
  })

  it('does NOT widen to a different address on the same LAN, only the exact bound one', async () => {
    const waechter = createLocalApiGuard(5273, () => ['http://192.168.1.23:5273'])
    const res = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      // A neighbour box on the same /24, not this server's own address.
      headers: { ...json, Origin: 'http://192.168.1.99:5273' }, body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('does NOT widen to the right host on a different port', async () => {
    const waechter = createLocalApiGuard(5273, () => ['http://192.168.1.23:5273'])
    const res = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'http://192.168.1.23:9999' }, body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('the getter is read PER REQUEST, not cached at guard creation (resolvedUrls populates after listen)', async () => {
    let active = false
    const waechter = createLocalApiGuard(5273, () => (active ? ['http://192.168.1.23:5273'] : []))
    const before = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'http://192.168.1.23:5273' }, body: '{}',
    })
    expect(before.status).toBe(403)
    active = true
    const after = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'http://192.168.1.23:5273' }, body: '{}',
    })
    expect(after.status).toBe(DURCHGEREICHT)
  })

  it('the DNS-rebinding protection is untouched: Host header still cannot authorise a request', async () => {
    // Same probe as waechter-und-port.test.ts, run again WITH a LAN getter
    // active, to prove the widening did not also open this hole.
    const waechter = createLocalApiGuard(5273, () => ['http://192.168.1.23:5273'])
    const res = await anfrage(waechter, {
      method: 'POST', url: '/shell-execute',
      headers: { ...json, Origin: 'http://boese.example', Host: 'boese.example' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('the rejection names the server\'s own LAN origin so the diagnosis stays honest', async () => {
    const waechter = createLocalApiGuard(5273, () => ['http://192.168.1.23:5273'])
    const res = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'https://boese.example' }, body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.text).toContain('192.168.1.23:5273')
  })

  it('still nothing to say when no LAN origin is active (message unchanged from before K8)', async () => {
    const waechter = createLocalApiGuard(5273, () => [])
    const res = await anfrage(waechter, {
      method: 'POST', url: '/onboarding-write',
      headers: { ...json, Origin: 'https://boese.example' }, body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('LAN')
  })
})

describe('K8: the real lanOrigins() (dev-server/index.ts) derives LAN origins only from --host, never from a request', () => {
  // K8 nachbessert (Review-Punkt 7): these three cases used to run against a
  // copy of the closure retyped into this test file, which only proved the
  // copy did what the copy did. They now call the real exported function.
  it('--host inactive: empty, regardless of resolvedUrls', async () => {
    expect(lanOrigins({ config: { server: {} }, resolvedUrls: { network: ['http://192.168.1.23:5273/'] } })).toEqual([])
  })

  it('--host active and resolved: the exact origin(s), trailing slash stripped', async () => {
    expect(lanOrigins({ config: { server: { host: true } }, resolvedUrls: { network: ['http://192.168.1.23:5273/'] } }))
      .toEqual(['http://192.168.1.23:5273'])
  })

  it('--host active but not yet resolved (pre-listen): empty, not a crash', async () => {
    expect(lanOrigins({ config: { server: { host: true } }, resolvedUrls: null })).toEqual([])
  })
})
