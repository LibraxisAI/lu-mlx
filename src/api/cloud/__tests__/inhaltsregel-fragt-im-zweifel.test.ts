/**
 * Die Altersbestaetigung haengt am Server, und im Zweifel wird gefragt.
 *
 * Entscheid vom 13.09.2026: fuer 3.0.0 faellt der Bestaetigungsschritt
 * weg und kommt in 3.0.1 wieder. Die Stellung steht im Server
 * (`AGE_CONFIRMATION_REQUIRED`, the web app) und kommt mit der
 * GET-Antwort von `/api/account/content-policy` als `ageConfirmationRequired`
 * mit. Die App haelt keine eigene Kopie davon.
 *
 * Der Posten hier ist der Rand des Vertrags, nicht die Oberflaeche: was
 * passiert, wenn das Feld fehlt oder Unsinn traegt. Ein aelterer oder gerade
 * nicht erreichbarer Server liefert es nicht, und daran darf eine
 * Altersschranke nicht verloren gehen.
 *
 * Lauf: npx vitest run src/api/cloud/__tests__/inhaltsregel-fragt-im-zweifel.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ fetch: vi.fn(), json: vi.fn() }))
vi.mock('../client', () => ({
  cloudFetch: http.fetch,
  jsonOrError: http.json,
  CloudJobError: class CloudJobError extends Error {},
}))

import { getContentPolicy, setContentPolicy } from '../jobs'

beforeEach(() => {
  http.fetch.mockReset()
  http.json.mockReset()
  http.fetch.mockResolvedValue({} as Response)
})

const antwortet = (nutzlast: unknown) => http.json.mockResolvedValue(nutzlast)
const rumpf = () => JSON.parse((http.fetch.mock.calls[0][1] as { body: string }).body)

describe('die Stellung des Bestaetigungsschritts', () => {
  it('kommt vom Server, wenn er sie nennt', async () => {
    for (const stellung of [true, false]) {
      http.json.mockReset()
      antwortet({ policy: 'soft', ageConfirmedAt: null, ageConfirmationRequired: stellung })
      expect((await getContentPolicy()).ageConfirmationRequired).toBe(stellung)
    }
  })

  it('faellt auf fragen zurueck, wenn das Feld fehlt', async () => {
    // Der ganze Grund dieser Datei. Ein Server ohne den Schalter kennt das Feld
    // nicht, und die vorsichtige Antwort ist die einzige, die keine Schranke
    // still verliert.
    antwortet({ policy: 'off', ageConfirmedAt: null })
    expect((await getContentPolicy()).ageConfirmationRequired).toBe(true)
  })

  it('faellt auch dann auf fragen zurueck, wenn das Feld kein Wahrheitswert ist', async () => {
    for (const muell of ['false', 0, null, 'nein', {}]) {
      http.json.mockReset()
      antwortet({ policy: 'soft', ageConfirmedAt: null, ageConfirmationRequired: muell })
      expect((await getContentPolicy()).ageConfirmationRequired, String(muell)).toBe(true)
    }
  })

  /**
   * NEGATIVKONTROLLE zur Leseart.
   *
   * Das Web liest `d.ageConfirmationRequired === true` und faellt damit auf
   * "kein Schritt" zurueck. Dort ist das richtig, weil das PUT derselben
   * Herkunft ohnehin abgewiesen wird. Hier waere es falsch, und ohne diese
   * Zeile saehe man dem Code nicht an, dass die Abweichung Absicht ist.
   */
  it('liest das Feld ausdruecklich anders als das Web, und das ist der Unterschied', async () => {
    const naivWieImWeb = (antwort: Record<string, unknown>) => antwort.ageConfirmationRequired === true
    expect(naivWieImWeb({ policy: 'soft' })).toBe(false)
    antwortet({ policy: 'soft', ageConfirmedAt: null })
    expect((await getContentPolicy()).ageConfirmationRequired).toBe(true)
  })
})

describe('was beim Setzen wirklich hinausgeht', () => {
  it('schickt keine Bestaetigung, die niemand gegeben hat', async () => {
    antwortet({ policy: 'off' })
    await setContentPolicy('off', false)
    expect(rumpf()).toEqual({ policy: 'off' })
    expect('ageConfirmed' in rumpf()).toBe(false)
  })

  it('schickt sie, wenn jemand sie gegeben hat', async () => {
    antwortet({ policy: 'off' })
    await setContentPolicy('off', true)
    expect(rumpf()).toEqual({ policy: 'off', ageConfirmed: true })
  })

  it('und schickt bei den harmlosen Stufen nichts dazu', async () => {
    antwortet({ policy: 'strict' })
    await setContentPolicy('strict')
    expect(rumpf()).toEqual({ policy: 'strict' })
  })
})
