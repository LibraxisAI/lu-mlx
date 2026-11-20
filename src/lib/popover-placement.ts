/**
 * Wohin ein Popover aufgeht, und wie hoch es dabei werden darf.
 *
 * ── Der Befund vom 07.09.2026 ──
 *
 * Der Inhaber: das Kontextfenster im Chat ist abgeschnitten, "wenn man den Context
 * neu ausfuellen moechte". Nachgemessen im laufenden Fenster (1280x800,
 * Chromium, `e2e/kontextfenster-wird-nicht-abgeschnitten.spec.ts`): die Liste
 * stand von y=686 bis y=874, also 74 px unter dem Fensterrand, und der
 * `<main>`-Kasten mit seiner abgerundeten Flaeche schneidet ohnehin schon bei
 * y=790,8 ab. Sichtbar waren 105 von 188 px, die Haelfte der Auswahl fehlte.
 *
 * Die Ursache ist keine Klasse, sondern eine Annahme: das Menue ging fest nach
 * unten auf (`top-full`), und sein Ausloeser ist mit dem 2.6.8-Umbau der
 * Eingabezeile von oberhalb des Verlaufs an den unteren Rand gewandert, direkt
 * ueber den Composer. Unter dem Ausloeser sind seitdem rund 100 px Platz, das
 * Menue braucht 188.
 *
 * ── Warum die Rechnung hier steht und nicht im Bauteil ──
 *
 * Weil sie sonst nicht pruefbar waere. Die Testumgebung dieses Hauses ist
 * `environment: 'node'`, es gibt dort kein Layout und keine
 * `getBoundingClientRect`. Was das Bauteil beitraegt, sind vier gemessene
 * Zahlen; was hier steht, ist die Entscheidung daraus, und die ist rein.
 *
 * ── Warum eine Grenze und nicht das Fenster ──
 *
 * Das Fenster ist nicht das, was abschneidet. In dieser App liegt ueber dem
 * Chat ein `<main>` mit `overflow-hidden` (die abgerundete Pane), und dessen
 * Unterkante liegt 9 px ueber der des Fensters. Wer gegen das Fenster rechnet,
 * kommt an einer Stelle heraus, die schon geschnitten wird, und der Fehler
 * kaeme in kleinerer Form zurueck. Deshalb bekommt diese Rechnung die
 * abschneidende Flaeche gesagt, nicht das Fenster.
 *
 * ── GitHub #149, 03.10.2026: zwei Masseinheiten in einer Rechnung ──
 *
 * Ein Nutzer, CachyOS mit Hyprland, AppImage: die Modellauswahl in Create ging im
 * hohen Fenster nach unten auf und lag unter dem Fensterrand, im halbhohen
 * stand sie 110 px ueber ihrem Ausloeser. Aus seinen Bildern nachgerechnet:
 * die App liegt unter `zoom: 1.15`, und das WebKitGTK des AppImage liefert
 * `getBoundingClientRect` in den Pixeln des gezoomten Elements (sichtbar durch
 * 1,15), `window.innerHeight` aber in sichtbaren Pixeln. Der Waehler zog das
 * eine vom anderen ab und sah unter dem Ausloeser 213 px Platz, wo 35 waren.
 * Chromium und neues WebKit liefern beides in sichtbaren Pixeln, dort stimmte
 * die Richtung, aber das Menue sass um den Zoomfaktor daneben, weil `top` an
 * einem gezoomten Element mitskaliert.
 *
 * Deshalb rechnet hier alles in EINER Einheit, den CSS-Pixeln des Popovers
 * (`lokaleMasse`), und jedes Popover der App geht ueber `usePopoverPlatz`.
 */

/** Die Zahlen, die das Bauteil misst. Alle in den CSS-Pixeln des Popovers. */
export interface PopoverRaum {
  /** Oberkante des Ausloesers. */
  readonly ankerOben: number
  /** Unterkante des Ausloesers. */
  readonly ankerUnten: number
  /** Oberkante der Flaeche, die abschneidet. */
  readonly grenzeOben: number
  /** Unterkante derselben Flaeche. */
  readonly grenzeUnten: number
  /** Was das Popover an Inhalt mitbringt, ungekuerzt. */
  readonly inhaltHoehe: number
  /** Abstand zwischen Ausloeser und Popover (`mt-1` / `mb-1` = 4 px). */
  readonly abstand: number
  /** Luft zwischen Popover und Kante der abschneidenden Flaeche. */
  readonly luft: number
  /** Die Seite, auf der das Popover aufgeht, solange es dort passt. Ohne Angabe unten. */
  readonly bevorzugt?: 'unten' | 'oben'
  /** Hoeher wird das Popover nie, auch wenn mehr Platz waere. */
  readonly deckel?: number
}

export interface PopoverPlatz {
  /** Geht das Popover nach oben auf statt nach unten? */
  readonly nachOben: boolean
  /** Die Hoehe, die es hoechstens einnehmen darf. Darueber scrollt es. */
  readonly maxHoehe: number
}

/**
 * Die Seite mit mehr Platz gewinnt, aber nur, wenn die bevorzugte nicht reicht.
 *
 * Kein "immer die groessere Seite": das Menue soll dort aufgehen, wo man es
 * erwartet, unter seinem Ausloeser, oder darueber, wenn der Ausloeser am
 * unteren Rand sitzt (`bevorzugt: 'oben'`). Zu kippen ist die Ausnahme, und
 * sie hat einen Grund, den man messen kann.
 *
 * Und ausdruecklich KEINE Mindesthoehe. Eine Mindesthoehe waere die Zusage,
 * bei genug Enge doch wieder ueber die Kante zu laufen, also genau der Fehler,
 * gegen den diese Datei geschrieben ist: der erste Anlauf hatte 96 px als
 * Untergrenze, und im 300 px hohen Fenster stand die Liste damit wieder 6 px
 * im Geschnittenen. Bleibt wenig Platz, wird das Menue kurz und scrollt; das
 * ist sichtbar wenig und nicht heimlich abgeschnitten.
 */
export function platzFuerPopover(raum: PopoverRaum): PopoverPlatz {
  const deckel = raum.deckel ?? Infinity
  const inhalt = Math.min(raum.inhaltHoehe, deckel)
  const unten = raum.grenzeUnten - raum.ankerUnten - raum.abstand - raum.luft
  const oben = raum.ankerOben - raum.grenzeOben - raum.abstand - raum.luft
  const nachOben = raum.bevorzugt === 'oben'
    ? !(inhalt > oben && unten > oben)
    : inhalt > unten && oben > unten
  const frei = Math.min(nachOben ? oben : unten, deckel)
  return { nachOben, maxHoehe: Math.max(0, Math.floor(frei)) }
}

/** Die waagerechte Lage eines Popovers und die Flaeche, in der es bleiben soll. */
export interface PopoverBreite {
  /** Linke Kante des Popovers an seinem natuerlichen Platz. */
  readonly links: number
  /** Rechte Kante ebenda. */
  readonly rechts: number
  readonly grenzeLinks: number
  readonly grenzeRechts: number
  readonly luft: number
}

/**
 * Um wie viel das Popover seitlich ruecken muss, damit es in der Flaeche bleibt.
 * Positiv heisst nach rechts. Ist es breiter als die Flaeche, gewinnt die linke
 * Kante: dort faengt der Text an.
 */
export function schubInDieFlaeche(b: PopoverBreite): number {
  const zuWeitRechts = b.rechts - (b.grenzeRechts - b.luft)
  const schub = zuWeitRechts > 0 ? -zuWeitRechts : 0
  const zuWeitLinks = b.grenzeLinks + b.luft - (b.links + schub)
  return Math.round(zuWeitLinks > 0 ? schub + zuWeitLinks : schub)
}

/** Ein Kasten, wie ihn `getBoundingClientRect` liefert. */
export interface Kasten {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/**
 * Can any part of the trigger be seen inside the panels it scrolls in?
 *
 * A trigger that sits in a scrolling panel can be scrolled out of it while its
 * popover is open. A popover that keeps following it then hangs from nothing:
 * measured in the advanced settings of Create (window 1280x560), the trigger
 * stood at y=805 and its list was drawn from y=512 to y=799, over the window
 * edge. Touching edges count as out of sight.
 */
export function ankerInSicht(anker: Kasten, flaeche: Kasten): boolean {
  return anker.bottom > flaeche.top && anker.top < flaeche.bottom
    && anker.right > flaeche.left && anker.left < flaeche.right
}

/** Was die Engine ueber den Massstab verraet, roh abgelesen. */
export interface Massstab {
  /** Der `zoom` der App-Wurzel, unter der der Ausloeser liegt (1 = keiner). */
  readonly zoom: number
  /**
   * `getBoundingClientRect` geteilt durch `offsetWidth`/`offsetHeight` an
   * dieser Wurzel. Chromium und neues WebKit: gleich dem Zoom, denn der Kasten
   * kommt in sichtbaren Pixeln. Aelteres WebKit (das WebKitGTK aus #149): 1,
   * der Kasten kommt schon in den Pixeln des gezoomten Elements.
   */
  readonly verhaeltnis: number
  /** `window.innerWidth`, in jeder Engine sichtbare Pixel. */
  readonly fensterBreite: number
  /** `window.innerHeight`, ebenso. */
  readonly fensterHoehe: number
}

/**
 * Mit welchem Faktor die Kaesten dieser Engine auf CSS-Pixel des gezoomten
 * Baums zurueckgehen. Es gibt nur die zwei Antworten "Zoom" und "1"; das
 * gemessene Verhaeltnis wird auf die naehere gerundet, weil `offsetHeight`
 * ganze Pixel liefert und der Quotient deshalb nie genau stimmt.
 */
export function kastenFaktor(zoom: number, verhaeltnis: number): number {
  return Math.abs(verhaeltnis - zoom) <= Math.abs(verhaeltnis - 1) ? zoom : 1
}

/**
 * Bringt Kaesten und Fenster in dieselbe Einheit: die CSS-Pixel des gezoomten
 * Baums, also die Einheit, in der `top`, `left` und `max-height` eines
 * Popovers gleich wieder gesetzt werden.
 */
export function lokaleMasse(m: Massstab): { kasten: (k: Kasten) => Kasten; fenster: Kasten } {
  const zoom = m.zoom > 0 ? m.zoom : 1
  const f = kastenFaktor(zoom, m.verhaeltnis)
  return {
    kasten: (k) => ({ top: k.top / f, bottom: k.bottom / f, left: k.left / f, right: k.right / f }),
    fenster: { top: 0, left: 0, right: m.fensterBreite / zoom, bottom: m.fensterHoehe / zoom },
  }
}

/** Die Lage eines Popovers, das mit `position: fixed` aus dem Baum herausgehoben ist. */
export interface FestePopoverLage extends PopoverPlatz {
  /** Abstand zur Fensteroberkante; gesetzt, wenn es nach unten aufgeht. */
  readonly top?: number
  /** Abstand zur Fensterunterkante; gesetzt, wenn es nach oben aufgeht. */
  readonly bottom?: number
  /** Gesetzt bei Ausrichtung links. */
  readonly left?: number
  /** Gesetzt bei Ausrichtung rechts: das Popover waechst von dort nach links. */
  readonly right?: number
  /** Der Ausloeser ist die Mindestbreite. */
  readonly minWidth: number
  readonly maxWidth: number
}

/**
 * Wo ein herausgehobenes Popover (Portal auf `body`, `position: fixed`) steht.
 * Abschneiden kann es nur das Fenster. Alle Zahlen in lokalen CSS-Pixeln.
 */
export function festeLage(e: {
  anker: Kasten
  fenster: Kasten
  /** Breite des Popovers, wie es gerade dasteht. */
  breite: number
  inhaltHoehe: number
  ausrichtung: 'links' | 'rechts'
  abstand: number
  luft: number
  bevorzugt?: 'unten' | 'oben'
  deckel?: number
}): FestePopoverLage {
  const platz = platzFuerPopover({
    ankerOben: e.anker.top,
    ankerUnten: e.anker.bottom,
    grenzeOben: e.fenster.top,
    grenzeUnten: e.fenster.bottom,
    inhaltHoehe: e.inhaltHoehe,
    abstand: e.abstand,
    luft: e.luft,
    bevorzugt: e.bevorzugt,
    deckel: e.deckel,
  })
  const senkrecht = platz.nachOben
    ? { bottom: e.fenster.bottom - e.anker.top + e.abstand }
    : { top: e.anker.bottom + e.abstand }
  const minWidth = e.anker.right - e.anker.left
  const fensterBreite = e.fenster.right - e.fenster.left
  if (e.ausrichtung === 'rechts') {
    const right = Math.max(e.luft, e.fenster.right - e.anker.right)
    return { ...platz, ...senkrecht, right, minWidth, maxWidth: Math.max(0, fensterBreite - right - e.luft) }
  }
  const breite = Math.max(e.breite, minWidth)
  const left = e.anker.left + schubInDieFlaeche({
    links: e.anker.left,
    rechts: e.anker.left + breite,
    grenzeLinks: e.fenster.left,
    grenzeRechts: e.fenster.right,
    luft: e.luft,
  })
  return { ...platz, ...senkrecht, left, minWidth, maxWidth: Math.max(0, fensterBreite - 2 * e.luft) }
}
