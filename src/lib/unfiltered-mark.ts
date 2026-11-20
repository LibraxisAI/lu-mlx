import type { CloudModel } from '../types/models'

/**
 * Die zwei Marken einer Modellzeile und ihre Woerter, an genau einer Stelle.
 *
 * `measured`: die gemessene Marke. Streng: nur ein Modell, das der Server als
 * `full` gemessen meldet, traegt sie. Der Messwert `partial` reist weiter im
 * Katalog, aber keine Flaeche macht daraus eine Marke: eine Marke, die
 * manchmal stimmt, ist im Kaufmoment schlimmer als keine, weil der Kunde sie
 * als Zusage liest. Die Messung selbst steht in `no-refusals-measurement.md`
 * neben dieser Datei.
 *
 * `statement`: die Modelle, die ihr Hersteller ohne Ablehnungsschicht
 * herausgibt und die die Wolke unveraendert und nur von einer festen
 * Gegenstelle ausliefert (Serverfeld `unrestricted`). Sie stehen an derselben
 * Stelle der Zeile wie die gemessene Marke, in der Akzentfarbe, und gehen der
 * gemessenen Marke vor.
 *
 * Entscheid vom 09.10.2026: die gemessene Marke heisst nicht mehr
 * "No refusals" und tritt optisch zurueck, das Wort der zweiten Marke ist die
 * Aussage. Kein eigenes Abzeichen: das farbige Wort an der alten Stelle ist
 * die Unterscheidung.
 *
 * GEWOLLTE ABWEICHUNG ZUM WEB: die Web-App auf lu-labs.ai schreibt fuer die
 * zweite Marke ein neutrales Wort und fuehrt die Modelle unter neutralen
 * Namen, weil auf der Zahlungsdomain das Wort der App nicht steht. Die App
 * nennt es beim Namen und zeigt die echten Modellnamen (`native_name` der
 * Modellliste, `native_label` des Medienkatalogs). Das Wort der gemessenen
 * Marke und beide Hovertexte sind
 * zeichengleich mit dem Web.
 */
export type ModelMark = 'statement' | 'measured' | null

export function traegtDieMarke(unfiltered: CloudModel['unfiltered'] | null | undefined): boolean {
  return unfiltered === 'full'
}

/** Welche Marke eine Zeile zeigt. Hoechstens eine. */
export function modelMark(model: {
  unfiltered?: CloudModel['unfiltered'] | null
  unrestricted?: boolean | null
}): ModelMark {
  if (model.unrestricted === true) return 'statement'
  return traegtDieMarke(model.unfiltered) ? 'measured' : null
}

/** Der Wortlaut der gemessenen Marke und ihr Hovertext: die Zeile der
 *  Modellauswahl, der Filter im Waehler, die Marke in Create und der Hinweis
 *  nach einer Ablehnung lesen ihn hier. */
export const UNFILTERED_MARK_LABEL = 'No Filter'
export const UNFILTERED_MARK_TITLE =
  "Measured: this model answers without refusing. Your account's content policy still applies."

/** Das Wort der zweiten Marke und ihr Gruppenkopf im Waehler. */
export const STATEMENT_MARK_LABEL = 'Uncensored'
export const STATEMENT_MARK_TITLE =
  "Released by its makers to answer without refusing, and never swapped for another model. Your account's content policy still applies."
