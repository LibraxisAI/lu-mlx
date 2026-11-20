/**
 * R5-30, Entscheid vom 12.09.2026: der Desktop bekommt den Altpfad fuer
 * alte Cloud-Erinnerungen, den bis dahin nur das Web hatte.
 *
 * Geprueft wird der Draht, nicht der Quelltext: welche Adresse wirklich
 * angefragt wird, was im Koerper steht und was eine Antwort ausloest, die
 * nicht passt.
 *
 * Run: npx vitest run src/api/cloud/__tests__/der-altpfad-im-desktop.test.ts
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const endpoint = vi.hoisted(() => ({ base: 'https://fixture.invalid' }))
vi.mock('../config', () => ({ get CLOUD_BASE() { return endpoint.base } }))
const auth = vi.hoisted(() => ({ getSession: vi.fn(), getUser: vi.fn(), unsubscribe: vi.fn() }))
const tabelle = vi.hoisted(() => ({ antwort: { data: null as unknown, error: null as unknown } }))
vi.mock('../supabase', () => ({
  supabaseCloud: () => ({
    auth: {
      getSession: auth.getSession,
      getUser: auth.getUser,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: auth.unsubscribe } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ abortSignal: () => ({ maybeSingle: () => Promise.resolve(tabelle.antwort) }) }),
      }),
    }),
  }),
}))

import { withMemorySyncSession } from '../memory-sync'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'

const fetcher = vi.fn()
const antwort = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  useCloudAuthStore.getState().setSignedIn({ id: 'a' }, { licenseActive: true, tier: null, access: true, quota: null })
  vi.stubGlobal('fetch', fetcher)
  fetcher.mockReset()
  auth.unsubscribe.mockReset()
  auth.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'synthetic-token-a', user: { id: 'a' } } } })
  auth.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'a' } }, error: null })
  tabelle.antwort = { data: null, error: null }
})
afterEach(() => { vi.unstubAllGlobals(); useCloudAuthStore.getState().setSignedOut() })

describe('die alte Kontokopie lesen', () => {
  it('gibt die alte Liste zurueck und schickt dafuer keine Anfrage ins Netz', async () => {
    tabelle.antwort = { data: { user_id: 'a', memories: [{ id: 'eins' }, { id: 'zwei' }] }, error: null }
    const alt = await withMemorySyncSession('a', session => session.pullLegacy())
    expect(alt).toEqual([{ id: 'eins' }, { id: 'zwei' }])
    expect(fetcher, 'der Lesepfad geht ueber die Datenbank, nicht ueber eine Route').not.toHaveBeenCalled()
  })

  it('nimmt keine leere Zeile als Verlust und keine fremde Zeile als eigene', async () => {
    expect(await withMemorySyncSession('a', session => session.pullLegacy())).toEqual([])
    tabelle.antwort = { data: { user_id: 'b', memories: [] }, error: null }
    await expect(withMemorySyncSession('a', session => session.pullLegacy())).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('die alte Kontokopie entfernen', () => {
  it('schickt den angesehenen Beleg an die Altroute und nirgendwo sonst hin', async () => {
    fetcher.mockResolvedValue(antwort({ ownerId: 'a', finalized: true }))
    await withMemorySyncSession('a', session => session.finalizeLegacy([{ id: 'eins' }], { eins: 3 }))
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://fixture.invalid/api/memory/legacy')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer synthetic-token-a')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body)).toEqual({
      expectedMemories: [{ id: 'eins' }], expectedRevisions: { eins: 3 }, confirmDiscard: true,
    })
  })

  it('glaubt kein Entfernen, das der Server nicht bestaetigt hat', async () => {
    fetcher.mockResolvedValue(antwort({ ownerId: 'a' }))
    await expect(withMemorySyncSession('a', session => session.finalizeLegacy([], {})))
      .rejects.toMatchObject({ kind: 'invalid' })
  })

  it('sagt bei einer Kollision, dass noch einmal hingesehen werden muss', async () => {
    fetcher.mockResolvedValue(antwort({ error: 'nope' }, 409))
    await expect(withMemorySyncSession('a', session => session.finalizeLegacy([], {})))
      .rejects.toMatchObject({ kind: 'conflict', message: 'Memories changed. Review the previous cloud copy again.' })
  })

  it('laesst den normalen Weg auf seiner eigenen Route und mit seiner eigenen Meldung', async () => {
    // Negativkontrolle: der neue Pfadparameter darf den Synchronisierungslauf
    // nicht mitnehmen. Gleiche Kollision, andere Route, andere Meldung.
    fetcher.mockResolvedValue(antwort({ error: 'nope' }, 409))
    await expect(withMemorySyncSession('a', session => session.write('eins', 0, { id: 'eins' })))
      .rejects.toMatchObject({ kind: 'conflict', message: 'Memory changed or was deleted. Pull before resolving the conflict.' })
    expect(fetcher.mock.calls[0][0]).toBe('https://fixture.invalid/api/memory/sync')
  })
})
