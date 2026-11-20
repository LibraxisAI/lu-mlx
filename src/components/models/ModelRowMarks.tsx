import type { CloudModel } from '../../types/models'
import { FLASH_MARK_LABEL, flashMarkTitle, useFlashEntitlement } from '../../lib/flash-entitlement'
import {
  modelMark, STATEMENT_MARK_LABEL, STATEMENT_MARK_TITLE, UNFILTERED_MARK_LABEL, UNFILTERED_MARK_TITLE,
} from '../../lib/unfiltered-mark'

/**
 * Die Marken an einer Zeile der Modellauswahl.
 *
 * Beide kommen aus dem Server-Katalog und nie aus dem Modellnamen:
 * `unfiltered` ist gemessen, `flash` ist die Klasse, die keine Credits kostet.
 * Eine Marke beschreibt das Modell, sie erlaubt nichts. Was eine Anfrage
 * enthalten darf, entscheidet der Server bei jedem Aufruf neu.
 *
 * Nur `full` wird markiert. Ein Modell, das teilweise mitgeht, bekommt keine
 * Marke: eine Marke, die manchmal stimmt, ist im Kaufmoment schlimmer als
 * keine, weil der Kunde sie als Zusage liest.
 *
 * Die Freimengenmarke sagt etwas ueber das KONTO und nicht nur ueber das
 * Modell, also fragt die Zeile das Konto (lib/flash-entitlement, dieselbe
 * Regel, nach der der Chat-Vermittler abrechnet). Der Server liefert `flash`
 * an jedes Konto mit Cloud; ein Konto ohne bezahlten Plan zahlt fuer genau
 * diese Modelle und darf die Marke nicht sehen. Eine noch unbeantwortete
 * Abfrage verspricht nichts.
 *
 * `row` ist die Zeile des Cloud-Waehlers: sie zeigt nur die gemessene Marke,
 * denn was ein Modell dieses Konto kostet, steht dort hinter dem Fragezeichen
 * der Zeile.
 *
 * Seit dem 09.10.2026 teilen sich zwei Woerter diesen Platz, nie beide
 * zugleich (lib/unfiltered-mark, `modelMark`): die gemessene Marke steht leise
 * da, grau im Haarlinienrahmen, und die Aussage der Modelle, die ihr
 * Hersteller ohne Ablehnungsschicht herausgibt, steht im Akzent mit Rahmen und
 * Toenung. Das farbige Wort ist die Unterscheidung, ein eigenes Abzeichen gibt
 * es nicht.
 *
 * Das Aussehen ist das Etikett der Waehler (index.css, .lu-picker-tag): eine
 * Haarlinie und Grau fuer die gemessene Marke, der eine Akzent fuer die
 * Aussage, Helligkeit und keine Farbe fuer "No credits". K12 (3.0.1, die Marke war nicht auffindbar) ist damit
 * anders geloest als frueher mit Icon und Fettung: die Marke hat einen eigenen
 * Rahmen, und der Waehler hat einen Filter, der nur markierte Modelle zeigt.
 */
export function ModelRowMarks({ model, row = false }: {
  model: { flash?: CloudModel['flash']; unfiltered?: CloudModel['unfiltered']; unrestricted?: boolean }
  row?: boolean
}) {
  const paidPlan = useFlashEntitlement()
  const freeFlash = !row && model.flash && paidPlan === true ? model.flash : undefined
  const mark = modelMark(model)
  return (
    <>
      {mark === 'statement' && (
        <span className="t-micro lu-picker-tag is-statement" title={STATEMENT_MARK_TITLE} data-mark="statement">
          {STATEMENT_MARK_LABEL}
        </span>
      )}
      {mark === 'measured' && (
        <span className="t-micro lu-picker-tag" title={UNFILTERED_MARK_TITLE} data-mark="unfiltered">
          {UNFILTERED_MARK_LABEL}
        </span>
      )}
      {freeFlash && (
        <span
          className="t-micro lu-picker-tag is-bright"
          title={flashMarkTitle(freeFlash.dailyTokens)}
          data-mark="unlimited"
        >
          {FLASH_MARK_LABEL}
        </span>
      )}
    </>
  )
}
