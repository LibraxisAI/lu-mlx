import { useMemoryStore } from '../stores/memoryStore'
import { syncMemoryHash } from './memory-sync-plan'
import { isRecord } from '../types/json-guards'

/**
 * Wie viele Erinnerungen des angemeldeten Kontos noch nicht in der Wolke
 * stehen (R3-19, Entscheid vom 12.09.2026).
 *
 * Das Abmelden raeumt die Kontosammlung aus der laufenden Ansicht. Wer vorher
 * nie synchronisiert hat, verliert damit nichts von der Platte, sieht seine
 * Eintraege auf dem naechsten Geraet aber nicht wieder, und genau das kommt
 * ohne Nachfrage als Verlust an.
 *
 * Gezaehlt wird gegen die SYNC-BASIS, nicht gegen eine Zeitmarke: eine
 * Erinnerung gilt als offen, wenn es fuer sie keine Basis gibt (nie
 * hochgeladen) oder wenn ihr Fingerabdruck von dem der Basis abweicht (seither
 * geaendert). Eine Erinnerung, die sich nicht lesen laesst, zaehlt als offen;
 * im Zweifel fragen ist billiger als im Zweifel schweigen.
 *
 * Loeschungen zaehlen nicht mit. Sie sind kein Datenverlust, und eine Zahl,
 * die sie mitnimmt, warnt vor etwas, das der Nutzer gerade selbst wollte.
 *
 * Kein Netz, kein Schreibzugriff: die Antwort kommt aus dem Speicher und aus
 * der Platte, nie von einem Server.
 */
export async function countUnsyncedAccountMemories(): Promise<number> {
  const state = useMemoryStore.getState()
  const owner = state.activeMemoryOwner
  if (owner === null) return 0
  const alle: unknown = state.memorySyncBaselines
  const gespeichert: unknown = isRecord(alle) && Object.hasOwn(alle, owner) ? alle[owner] : undefined
  const basen = isRecord(gespeichert) ? gespeichert : {}
  let offen = 0
  for (const eintrag of state.entries) {
    const basis: unknown = Object.hasOwn(basen, eintrag.id) ? basen[eintrag.id] : undefined
    if (!isRecord(basis) || typeof basis.hash !== 'string') { offen++; continue }
    try {
      if (await syncMemoryHash(eintrag) !== basis.hash) offen++
    } catch { offen++ }
  }
  return offen
}
