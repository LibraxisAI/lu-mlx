import type { ChatMessage } from '../../api/providers/types'
import { runLedger, type DecayMessage } from '../../lib/context-decay'

/**
 * Die versteckte Werkzeugkette, die der naechste Zug wiederbekommt.
 *
 * Der Schnitt trennt die REGEL vom Schreibvorgang. Was in useCodex.ts
 * uebrigbleibt, ist das Einfuegen in den Chat-Speicher; was hier steht, ist die
 * Auswahl — und die hat zwei Gruende, die einander bedingen:
 *
 *  1. DIE DECKELUNG (Pruefung E2). Ungedeckelt legte ein Lauf mit 200
 *     Durchlaeufen hunderte versteckte Nachrichten zu je bis zu 60k Zeichen an
 *     — zweistellige Megabytes in EINEM Gespraech, die jede spaetere
 *     Speicherung neu durchschreiben musste. Die juengste Kette ist das, was
 *     der naechste Zug wirklich braucht; aeltere Schritte stehen ohnehin im
 *     sichtbaren Verlauf.
 *
 *  2. DER WAISENSCHNITT. Die Deckelung allein WAERE EIN FEHLER: schneidet das
 *     Fenster mitten in ein Aufruf/Ergebnis-Paar, beginnt die behaltene Kette
 *     mit einem Ergebnis, dessen Aufruf draussen liegt. Ein strenger Anbieter
 *     (lu-cloud) antwortet darauf mit 422 und der ganze
 *     Folgezug faellt aus. Deshalb gehoeren die beiden Schritte zusammen und
 *     nicht in zwei Zeilen quer durch einen `finally`-Block.
 *
 * Rein und damit pruefbar — inklusive des Grenzfalls, den man sonst nie sieht:
 * ein Fenster, das AUSSCHLIESSLICH aus Ergebnissen besteht, bleibt leer.
 */

/** Was der naechste Zug hoechstens an versteckter Kette wiederbekommt. */
export const HIDDEN_HISTORY_MAX = 60

export function capHiddenToolHistory(
  all: ChatMessage[],
  max: number = HIDDEN_HISTORY_MAX,
): ChatMessage[] {
  let toolHistory = all.slice(-max)
  // Never start the kept slice on an orphan tool result — strict
  // providers 422 a result whose call fell outside the window.
  while (toolHistory.length > 0 && toolHistory[0].role === 'tool') toolHistory = toolHistory.slice(1)
  // 3. DAS PROTOKOLL (Kundenfall 30.09.2026, a user: "when it stopped
  // i will continue the task then its start from again"). Was hier
  // wegfaellt, stand NICHT im sichtbaren Verlauf, die Blase zeigt nur den
  // Schlusstext. Nach "continue" sah das Modell die letzten 30 Schritte und
  // nichts davor, also fing es von vorn an. Die weggeschnittenen Aufrufe
  // kommen deshalb als eine Zeile je Aufruf an die erste behaltene Nachricht.
  const dropped = all.slice(0, all.length - toolHistory.length)
  const ledger = dropped.length > 0 ? runLedger(dropped as unknown as DecayMessage[]) : null
  if (ledger && toolHistory.length > 0) {
    const [first, ...rest] = toolHistory
    const body = typeof first.content === 'string' ? first.content : ''
    toolHistory = [{ ...first, content: body ? `${ledger}\n\n${body}` : ledger }, ...rest]
  }
  return toolHistory
}
