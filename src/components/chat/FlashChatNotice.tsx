import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { clearFlashNotices, useFlashBillingStore } from '../../lib/flash-ui'
import { FLASH_UNPAID_NOTICE, useFlashEntitlement } from '../../lib/flash-entitlement'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { TOOLBAR_LABEL_TEXT } from './AgentModeToggle'

/**
 * Was eine Runde auf dem gewaehlten Modell dieses Konto kostet, als kleiner
 * Hinweis in der Sitzungsleiste statt als stehendes Band ueber der Eingabe.
 *
 * 19.09.2026: das alte Band stand dauerhaft ueber dem Eingabefeld, sah
 * schlecht aus und schob den Agent-Schalter, die Kontextanzeige und Memories
 * nach oben. Der Hinweis ist jetzt ein einzeiliges Etikett neben dem
 * Agent-Schalter, das ein Popup oeffnet statt Platz zu beanspruchen. Bauart
 * wortgleich mit `SamplingControls`, dem Haus-Muster fuer genau dieses Popup
 * (Trigger oeffnet, Escape/X/Aussenklick schliessen, Fokus geht rein und
 * zurueck), damit nicht ein zweites Muster fuer dasselbe Verhalten entsteht.
 *
 * Runde 2 (19.09.2026, derselbe Tag): drei Nachbesserungen aus der Abnahme,
 * plus ein Nachtrag desselben Tages.
 *   1. Die gruene "No credits"-Marke UEBER dem Eingabefeld ist weg, dieses
 *      Etikett hier ersetzt sie. Der Nachtrag ging weiter: die ganze Zeile
 *      ueber dem Eingabefeld (auch "No Filter") ist geloescht, nicht nur
 *      entkoppelt. In der Modellauswahl selbst bleiben beide Marken stehen
 *      (`ModelRowMarks.tsx`, unberuehrt, siehe `ModelSelector.tsx`).
 *   2. Das Popup hatte einen leeren Streifen ohne sichtbares X und neun Saetze
 *      Fliesstext. Es traegt jetzt eine kleine Ueberschrift, die den Zustand
 *      benennt, das X liegt sichtbar daneben, und die Bedingungen stehen als
 *      kurze Liste statt als Absatz. Keine Bedingung ist dabei weggefallen,
 *      nur knapper gefasst; was sich nicht in eine Zeile bringen liess (die
 *      Reservierungsregel) steht als letzter kleiner Absatz darunter.
 *   3. Der Trigger traegt jetzt dieselbe Schriftgroesse wie "Agent" daneben:
 *      `TOOLBAR_LABEL_TEXT` aus `AgentModeToggle.tsx` (vorher `t-micro` =
 *      10px, sichtbar groesser als die 8,8px des Nachbarn) und
 *      `aria-haspopup="dialog"`. Geteilte Konstante statt einer zweiten
 *      Kopie derselben arbitraeren Schriftgroesse, siehe der Kommentar an
 *      der Konstante: `die-typo-leiter-und-ihre-umgehung.test.ts` deckelt
 *      genau das.
 *   4. Bei schmalem Fenster lief das Panel mit festem `left: 0` rechts aus dem
 *      Fenster (Screenshot der ersten Runde, rechts abgeschnitten). `left`
 *      wird jetzt aus der Fensterbreite berechnet (`clampNoticeLeft`, pure und
 *      damit ohne DOM testbar) und bei jedem Resize neu gemessen, solange das
 *      Panel offen ist. Bleibt `position: absolute`, wie zuvor: kein Portal
 *      noetig, diese App hat keinen Zoom-Wrapper, den ein Portal umgehen
 *      muesste.
 *
 * Runde 3 (Abnahme 19.09.2026, Blocker A1): die Annahme aus Runde 2, das
 * Panel duerfe nach unten oeffnen, war falsch. Die Sitzungsleiste steht in
 * dieser App unter dem Transkript, direkt ueber dem Composer
 * (`ChatView.tsx:506`), nicht oben. Unten bleiben nur rund 90 bis 140 px bis
 * zum Fensterrand, das rund 275 px hohe Panel wurde dort abgeschnitten, von
 * einem `overflow-hidden`-Vorfahren (`ChatView.tsx:280`). Das Panel oeffnet
 * jetzt nach OBEN (`bottom: '100%'`, wie `SamplingControls`) und klemmt
 * zusaetzlich seine Hoehe auf den frei bleibenden Platz ueber dem Trigger
 * (`clampNoticeMaxHeight`, `overflow-y: auto`), damit es auch in einem
 * niedrigen Fenster nicht oben aus dem Bild laeuft. Ausserdem ist das
 * doppelte `aria-label` neben `aria-labelledby` am Panel weg: `aria-labelledby`
 * gewinnt ohnehin, das zweite war toter Code.
 *
 * Zwei Sorten Text leben hier und verhalten sich mit Absicht verschieden:
 *   - die Zeilen je Anfrage melden eine Antwort, die schon zurueck ist. Sie
 *     veralten, sobald diese Oberflaeche weg ist, also raeumen Fokus und Blur
 *     sie ab.
 *   - der stehende Satz darueber beschreibt das gewaehlte Modell und den Plan
 *     dieses Kontos. Das veraltet durch einen Blur nicht, er bleibt stehen.
 *     Seine Kontohaelfte kommt aus dem Kontospeicher, den `useCloudAuth` im
 *     Takt aus `/api/me` nachzieht.
 *
 * Das Etikett selbst traegt die Farbe: GRUEN nur, wenn diese Runde wirklich
 * keine Credits kostet (bezahlter Plan, Freimenge nicht aufgebraucht). Faellt
 * die Anfrage auf Credits zurueck (Freimenge aufgebraucht) oder zahlt das
 * Konto ohnehin fuer dieses Modell (kein bezahlter Plan), steht an derselben
 * Stelle derselbe neutrale Text, nie Gruen: eine falsche Zusage waere hier
 * schlimmer als keine.
 */

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Panel width, matching the sampling popup's own fixed width class of sizes. */
const PANEL_WIDTH = 280

/** Breathing room kept between the panel and the window edge. */
const PANEL_MARGIN = 8

/** Gap between the trigger row and the panel. */
const PANEL_GAP = 6

/** The close button's accessible name, mirrored in the web app. */
export const FLASH_NOTICE_CLOSE_LABEL = 'Close Flash usage details'

/** The trigger's own label per state, mirrored in the web app. */
export const FLASH_NOTICE_LABEL_FREE = 'Using no credits'
export const FLASH_NOTICE_LABEL_CREDITS = 'Using credits'

/** The popup's own heading per state, mirrored in the web app: names WHY the
 *  trigger reads what it reads, instead of leaving the reader to infer it
 *  from a wall of text. */
export const FLASH_NOTICE_HEADING_FREE = 'Flash models use no credits'
export const FLASH_NOTICE_HEADING_UNPAID = 'Flash models need a paid plan'
export const FLASH_NOTICE_HEADING_EXHAUSTED = "Today's free allowance is used"

/**
 * Where the panel's left edge lands, clamped into the window.
 *
 * The trigger sits near the LEFT of a narrow session strip, so the panel's
 * natural anchor is `left: 0` (its own left edge flush with the trigger's).
 * That ran the panel off the right side of a narrow window, because nothing
 * ever asked how wide the window actually was. Pure function so the clamp
 * itself is testable without mounting a DOM.
 */
export function clampNoticeLeft(wrapLeft: number, viewportWidth: number, wanted: number): { left: number; width: number } {
  const width = Math.min(wanted, Math.max(viewportWidth - PANEL_MARGIN * 2, 0))
  const naturalViewportLeft = wrapLeft // left: 0 means "flush with the trigger"
  const clampedViewportLeft = Math.min(
    Math.max(naturalViewportLeft, PANEL_MARGIN),
    Math.max(viewportWidth - width - PANEL_MARGIN, PANEL_MARGIN),
  )
  return { left: clampedViewportLeft - wrapLeft, width }
}

/**
 * How tall the panel is allowed to be, given where the trigger sits.
 *
 * Runde 3 (Abnahme 19.09.2026, Blocker A1): die Sitzungsleiste, in der dieser
 * Trigger steht, sitzt in dieser App UNTER dem Transkript, direkt ueber dem
 * Composer (`ChatView.tsx:506`), nicht oben wie der Beweis-Harness der
 * vorigen Runde es zeigte. Unter der Leiste bleiben nur noch rund 90 bis
 * 140 px bis zum Fensterrand, das Panel selbst ist rund 275 px hoch. Es
 * oeffnet deshalb jetzt nach OBEN (`bottom: '100%'`, wie `SamplingControls`),
 * und diese Funktion klemmt seine Hoehe auf den Platz, der oberhalb des
 * Triggers tatsaechlich frei ist, genau wie `placePopover` es im Web fuer den
 * Fall `openUpward` tut. Pure, damit die Klemme ohne DOM testbar ist.
 */
export function clampNoticeMaxHeight(wrapTop: number): number {
  return Math.max(wrapTop - PANEL_GAP - PANEL_MARGIN, 0)
}

/**
 * The area that actually clips this popup, not the window.
 *
 * Found live while proving Blocker A1 at 360px width, not simulated: clamping
 * against `window.innerWidth` lets the panel reach into the space the sidebar
 * covers, because `ChatView.tsx` wraps the transcript-plus-composer column in
 * a `<main overflow-hidden>` pane narrower than the window. A panel placed
 * there is still found by `getBoundingClientRect` (so every other check here
 * would have stayed green), but the close button ends up behind the sidebar,
 * where a browser's focus-follow scrolls it into view: since `overflow-hidden`
 * still allows a programmatic `scrollLeft`, that scroll dragged the WHOLE chat
 * column sideways, not just this popup. Same fix as `ContextDropdown.tsx`'s
 * `abschneidendeFlaeche`, for both axes instead of one: walk up for the first
 * ancestor that actually clips, and clamp against ITS box, not the window's.
 */
function abschneidendeFlaeche(el: Element): { oben: number; links: number; rechts: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
      const r = p.getBoundingClientRect()
      return { oben: r.top, links: r.left, rechts: r.right }
    }
  }
  return { oben: 0, links: 0, rechts: window.innerWidth }
}

export function FlashChatNotice() {
  useEffect(() => {
    // Another tab can change the account while this surface is unfocused.
    window.addEventListener('blur', clearFlashNotices)
    window.addEventListener('focus', clearFlashNotices)
    return () => {
      window.removeEventListener('blur', clearFlashNotices)
      window.removeEventListener('focus', clearFlashNotices)
      clearFlashNotices()
    }
  }, [])

  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const headingId = useId()
  const [panelBox, setPanelBox] = useState<{ left: number; width: number; maxHeight: number | undefined }>({
    left: 0,
    width: PANEL_WIDTH,
    // Unmeasured yet: CSS rejects `Infinity`, so "no clamp" means "no
    // property" until the layout effect below measures the real value.
    maxHeight: undefined,
  })

  const active = useModelStore((s) => s.models.find((m) => m.name === s.activeModel))
  const policy = active && 'flash' in active ? active.flash : undefined
  const notice = useFlashBillingStore((s) => (policy ? s.entries[policy.billingKey] : undefined))
  const paidPlan = useFlashEntitlement()

  // Give the keyboard back to the trigger, but only while it is still in the
  // popup: on an outside press the browser is already moving it somewhere the
  // user chose. Same rule as SamplingControls.close.
  const close = useCallback(() => {
    const panel = panelRef.current
    if (panel && panel.contains(document.activeElement)) {
      wrapRef.current?.querySelector('button')?.focus()
    }
    setOpen(false)
  }, [])
  useDismissOnEscape(open, close)

  useEffect(() => {
    if (!open) return
    const aus = (e: Event) => {
      const target = e.target as Node | null
      if (!target) return
      if (wrapRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', aus)
    return () => document.removeEventListener('pointerdown', aus)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    // `preventScroll`: found live at 360px width (Runde 3) that a plain
    // `.focus()` here made the browser scroll the close button into view on
    // its OWN terms, through the nearest ancestor that still allows a
    // programmatic `scrollLeft` despite `overflow-hidden`
    // (`ChatView.tsx`'s clipped main pane). That scroll dragged the whole
    // chat column sideways, not just this popup, and outlived the popup
    // itself. The panel's own position is already placed and clamped by the
    // layout effect below; the browser's own idea of "into view" is not
    // needed on top of it and only fights it.
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
  }, [open])

  // Measured once on open and again on every resize while open, so a window
  // dragged narrower while the popup is up never leaves it hanging off the
  // edge either.
  //
  // Runde 3 (Abnahme 19.09.2026, Auflage A5): die ganze App liegt unter einem
  // `zoom: var(--ui-scale)` (index.css:518), das Runde-2-Kommentar oben
  // ("diese App hat keinen Zoom-Wrapper") war schlicht falsch. Unter Zoom
  // zaehlen zwei Messwege verschieden: `getBoundingClientRect` liefert
  // SICHTBARE Pixel, `left`/`width` als Inline-Style werden aber als CSS-Pixel
  // des Elements interpretiert und danach erneut mit dem Zoom multipliziert.
  // Bei `--ui-scale` 1,15 blieb das lange unbemerkt; erst bei 360px Fenster-
  // breite riss die Differenz das Panel weit nach links aus dem Bild (das
  // Auflage-A5-Bild der letzten Runde). `ContextDropdown.tsx:123` hat dieselbe
  // Rechnung schon einmal geloest: die Skala aus der Differenz von
  // `getBoundingClientRect` und `offsetWidth` bestimmen und beide Messgroessen
  // vor dem Clamp durch sie teilen, damit Rechteck und Grenzflaeche in
  // derselben Einheit stehen wie die spaeter gesetzten Style-Werte.
  //
  // Zweiter Fund derselben Runde, am echten 360px-Fenster: geklemmt wurde
  // gegen `window.innerWidth`, nicht gegen die Flaeche, die wirklich schneidet
  // (die Sidebar liegt VOR dem `<main overflow-hidden>`, das den Chat
  // umschliesst). Das Panel durfte also bis an den Fensterrand rutschen, also
  // teilweise HINTER die Sidebar, wo sein X zwar noch `getBoundingClientRect`
  // fand, aber fuer den Fokus-Sprung beim Oeffnen "nicht sichtbar" war. Der
  // Browser holt ein fokussiertes, verdecktes Element in Sicht, indem er den
  // naechsten scrollbaren Vorfahren scrollt, und `overflow-hidden` verhindert
  // das nicht, nur die Bildlaufleiste dazu. Das Ergebnis: der ganze Chat
  // rutschte beim Oeffnen dieses Popups seitlich weg, nicht nur das Panel.
  // `abschneidendeFlaeche` (oben) ist dieselbe Suche wie in ContextDropdown,
  // fuer beide Achsen statt nur die Hoehe.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      const skala = wrap.offsetWidth > 0 ? rect.width / wrap.offsetWidth : 1
      const grenze = abschneidendeFlaeche(wrap)
      // In der Einheit von `clampNoticeLeft`s "Fenster": die schneidende
      // Flaeche selbst wird zum Rahmen, links bei 0.
      const wrapLeftInGrenze = (rect.left - grenze.links) / skala
      const grenzeBreite = (grenze.rechts - grenze.links) / skala
      setPanelBox({
        ...clampNoticeLeft(wrapLeftInGrenze, grenzeBreite, PANEL_WIDTH),
        maxHeight: clampNoticeMaxHeight((rect.top - grenze.oben) / skala),
      })
    }
    place()
    window.addEventListener('resize', place)
    // Runde 4 (19.09.2026): bisher stand hier nur `resize`. Ein Scroll auf
    // einem der beiden Vorfahren, die diese Rechnung schon kennt
    // (`abschneidendeFlaeche` und die 360px-Zeile in `ChatInput.tsx`), aendert
    // `rect`/`grenze` genauso wie ein Resize, ohne dass eines gefeuert wird:
    // das Panel blieb an der ALTEN Stelle haengen, obwohl sein Ausloeser
    // laengst woanders stand. `capture: true`, weil ein Scroll auf einem
    // inneren Container (die Composer-Zeile zum Beispiel) nicht zum `window`
    // hochblubbert, nur in der Einfangphase ankommt, dasselbe Argument wie
    // `useAnchoredPopover.ts` (Web) und `create/ui/Select.tsx`/`Tooltip.tsx`
    // (Desktop) es fuer ihre eigenen Popover schon fuehren. `passive: true`,
    // weil `place()` nichts an dem Scroll selbst aendert (kein
    // `preventDefault`), nur danach neu misst.
    window.addEventListener('scroll', place, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  if (!policy) return null
  // Noch nicht beantwortet. Schweigen ist der einzige ehrliche Zustand: beide
  // Saetze im Popup sind Aussagen ueber Geld.
  if (paidPlan === null) return null

  // Gruen ist nur wahr, solange diese Runde wirklich nichts kostet: ein
  // bezahlter Plan UND keine bereits gemeldete Rueckkehr auf Credits.
  const usesCredits = !paidPlan || notice?.billing === 'credits'
  const label = usesCredits ? FLASH_NOTICE_LABEL_CREDITS : FLASH_NOTICE_LABEL_FREE
  const heading = !paidPlan
    ? FLASH_NOTICE_HEADING_UNPAID
    : notice?.billing === 'credits'
      ? FLASH_NOTICE_HEADING_EXHAUSTED
      : FLASH_NOTICE_HEADING_FREE

  return (
    <div className="relative shrink-0" ref={wrapRef} data-testid="flash-chat-notice">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        data-testid="flash-chat-notice-trigger"
        title="Flash usage for this chat"
        // Dieselbe Schriftgroesse und Grundlinie wie "Agent" daneben
        // (AgentModeToggle.tsx), damit die beiden Etiketten in der Leiste wie
        // ein Satz aussehen statt wie zwei verschiedene Schriften.
        className={
          usesCredits
            ? `${TOOLBAR_LABEL_TEXT} whitespace-nowrap text-gray-500 hover:text-gray-300 transition-colors`
            : `${TOOLBAR_LABEL_TEXT} whitespace-nowrap text-emerald-600 dark:text-emerald-400 hover:text-emerald-500 transition-colors`
        }
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          data-testid="flash-chat-notice-panel"
          // Out of flow, exactly like SamplingControls: the row it hangs off
          // keeps its size and position to the pixel, whatever this says.
          // Opens UPWARD (`bottom: '100%'`): the session strip this trigger
          // lives in sits right above the composer, near the bottom of the
          // window, so opening down runs the panel off-screen and, worse,
          // clips it inside ChatView's `overflow-hidden` ancestor. `maxHeight`
          // plus `overflow-y: auto` keep it from running off the TOP of a
          // short window instead, the same way `clampNoticeLeft` keeps it on
          // screen sideways.
          style={{
            position: 'absolute',
            left: panelBox.left,
            bottom: '100%',
            marginBottom: PANEL_GAP,
            width: panelBox.width,
            maxHeight: panelBox.maxHeight,
            overflowY: 'auto',
          }}
          className="z-50 rounded-lg p-2.5 lu-elevated text-xs text-gray-500"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h2 id={headingId} className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              {heading}
            </h2>
            <button
              type="button"
              aria-label={FLASH_NOTICE_CLOSE_LABEL}
              title={FLASH_NOTICE_CLOSE_LABEL}
              data-testid="flash-chat-notice-close"
              className="shrink-0 rounded p-0.5 text-gray-500 hover:text-gray-300"
              onClick={close}
            >
              <X size={13} />
            </button>
          </div>

          {!paidPlan ? (
            <p>{FLASH_UNPAID_NOTICE}</p>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  {policy.dailyTokens.toLocaleString('en-US')} input and output tokens per day, free of credits.
                  Resets at 00:00 UTC.
                </li>
                <li>One free request at a time per account.</li>
                <li>API keys always use credits.</li>
                <li>A request beyond the allowance uses credits instead.</li>
                <li>
                  Free requests: up to {policy.defaultMaxOutput.toLocaleString('en-US')} output tokens,{' '}
                  {policy.requestSeconds} seconds.
                </li>
              </ul>
              <p className="mt-1.5">
                The request budget is reserved before generation. A failed or interrupted request without final
                usage keeps that reservation.
              </p>
              {notice?.billing === 'credits' && (
                <p role="alert" className="mt-1.5 text-gray-700 dark:text-gray-200">
                  {notice.ok ? 'This request uses credits instead of the free Flash allowance.' : 'This request requires credits. No generation started.'}
                  {' '}Its token budget exceeds the available allowance.
                </p>
              )}
              {notice?.billing === 'flash' && (
                <p role="status" className="mt-1.5">
                  Free Flash request. Remaining after reservation: {notice.remaining.toLocaleString('en-US')} tokens.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
