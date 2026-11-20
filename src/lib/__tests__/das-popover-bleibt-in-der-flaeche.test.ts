import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { festeLage, kastenFaktor, lokaleMasse, platzFuerPopover, schubInDieFlaeche } from '../popover-placement'

/**
 * Der Befund vom 07.09.2026: das Kontextfenster im Chat war abgeschnitten.
 *
 * Gemessen bei 1280x800 (`e2e/kontextfenster-wird-nicht-abgeschnitten.spec.ts`,
 * vor der Reparatur): die Liste stand von y=686 bis y=874, das Fenster endet
 * bei 800 und der `<main>`-Kasten mit `overflow-hidden` schon bei 790,8. Die
 * Zahlen unten sind genau diese Messung, nur in die CSS-Pixel der Liste
 * umgerechnet (die App liegt unter `zoom: var(--ui-scale)`).
 *
 * Was hier NICHT geprueft wird, ist das Messen selbst: dafuer braucht es ein
 * Layout, und die Testumgebung dieses Hauses ist `environment: 'node'`. Das
 * uebernimmt der e2e-Fall am laufenden Fenster. Hier steht die Entscheidung,
 * die aus vier Zahlen folgt.
 */

/** Der gemessene Fall aus dem Chat, in CSS-Pixeln. */
const CHAT = {
  ankerOben: 574,
  ankerUnten: 592,
  grenzeOben: 80,
  grenzeUnten: 687,
  inhaltHoehe: 162,
  abstand: 4,
  luft: 8,
}

describe('das Popover kippt, wenn unten kein Platz mehr ist', () => {
  it('der gemessene Chat-Fall geht nach oben auf', () => {
    // Unter dem Ausloeser: 687 - 592 - 12 = 83 Pixel fuer 162 Pixel Inhalt.
    // Darueber: 574 - 80 - 12 = 482. Genau das war der Fehler.
    const p = platzFuerPopover(CHAT)
    expect(p.nachOben).toBe(true)
    expect(p.maxHoehe).toBe(482)
  })

  it('und bleibt unten, solange es dort passt', () => {
    // Derselbe Ausloeser in einer Kopfzeile (so steht er im Code-Bereich):
    // unten ist Platz, also gibt es keinen Grund zu kippen.
    const p = platzFuerPopover({ ...CHAT, ankerOben: 100, ankerUnten: 118 })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(557)
  })

  it('NEGATIVKONTROLLE: gleich viel Platz kippt NICHT', () => {
    // Kippen ist die Ausnahme und braucht einen Grund. Bei Gleichstand bleibt
    // das Menue, wo Menues in dieser App aufgehen: unter ihrem Ausloeser.
    const p = platzFuerPopover({
      ...CHAT, grenzeOben: 0, ankerOben: 100, ankerUnten: 200, grenzeUnten: 300,
    })
    expect(p.nachOben).toBe(false)
  })
})

describe('die Hoehe ist gedeckelt, und der Deckel luegt nicht', () => {
  it('bei wenig Platz auf beiden Seiten gewinnt die groessere und wird gekuerzt', () => {
    // Das flache Fenster: unten 83, oben 40. Es passt nirgends, also nimmt es
    // die groessere Seite und scrollt darin.
    const p = platzFuerPopover({ ...CHAT, grenzeOben: 522 })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(83)
  })

  it('KEINE Mindesthoehe, denn eine Mindesthoehe ist die Zusage abzuschneiden', () => {
    // Der erste Anlauf hatte 96 Pixel als Untergrenze. Im 300 Pixel hohen
    // Fenster stand die Liste damit wieder im Geschnittenen, nur weniger weit.
    // Der Deckel ist deshalb NIE groesser als der Platz, den es wirklich gibt.
    const eng = platzFuerPopover({ ...CHAT, grenzeUnten: 620, grenzeOben: 560 })
    expect(eng.maxHoehe).toBeLessThanOrEqual(620 - 592 - 12)
  })

  it('und nie negativ, auch wenn der Anker schon ausserhalb steht', () => {
    const p = platzFuerPopover({ ...CHAT, grenzeUnten: 500, grenzeOben: 480 })
    expect(p.maxHoehe).toBeGreaterThanOrEqual(0)
  })
})

describe('GitHub #149: unten Platz, oben Platz, keiner reicht', () => {
  /** Ein 30 px hoher Ausloeser in einem 400 px hohen Fenster, die Liste will 300. */
  const LISTE = { grenzeOben: 0, grenzeUnten: 400, inhaltHoehe: 300, abstand: 4, luft: 8 }

  it('unten ist Platz: sie geht nach unten auf und wird nicht gekuerzt', () => {
    const p = platzFuerPopover({ ...LISTE, ankerOben: 20, ankerUnten: 50 })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(338)
  })

  it('unten ist keiner, oben schon: sie geht nach oben auf', () => {
    const p = platzFuerPopover({ ...LISTE, ankerOben: 350, ankerUnten: 380 })
    expect(p.nachOben).toBe(true)
    expect(p.maxHoehe).toBe(338)
  })

  it('keiner reicht: die groessere Seite, gekuerzt auf das, was da ist', () => {
    // Ausloeser in der Mitte: oben 138, unten 188. Die Liste scrollt in 188.
    const p = platzFuerPopover({ ...LISTE, ankerOben: 150, ankerUnten: 200 })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(188)
    expect(p.maxHoehe).toBeLessThan(LISTE.inhaltHoehe)
  })

  it('ein Popover, das oben zu Hause ist, bleibt oben, solange es passt', () => {
    const p = platzFuerPopover({ ...LISTE, inhaltHoehe: 100, ankerOben: 150, ankerUnten: 200, bevorzugt: 'oben' })
    expect(p.nachOben).toBe(true)
    expect(p.maxHoehe).toBe(138)
  })

  it('und kippt nach unten, wenn oben zu wenig und unten mehr ist', () => {
    const p = platzFuerPopover({ ...LISTE, ankerOben: 40, ankerUnten: 70, bevorzugt: 'oben' })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(318)
  })

  it('der Deckel haelt die Liste klein, auch wenn mehr Platz waere', () => {
    const p = platzFuerPopover({ ...LISTE, grenzeUnten: 2000, ankerOben: 20, ankerUnten: 50, deckel: 256 })
    expect(p.maxHoehe).toBe(256)
    // Und er entscheidet mit: 300 px Inhalt, die auf 256 gedeckelt sind,
    // passen in 260 px und muessen nicht kippen.
    const knapp = platzFuerPopover({ ...LISTE, grenzeUnten: 800, ankerOben: 500, ankerUnten: 528, deckel: 256 })
    expect(knapp.nachOben).toBe(false)
  })
})

describe('seitlich bleibt das Popover in der Flaeche', () => {
  const FLAECHE = { grenzeLinks: 0, grenzeRechts: 900, luft: 8 }

  it('passt es, rueckt es nicht', () => {
    expect(schubInDieFlaeche({ ...FLAECHE, links: 100, rechts: 340 })).toBe(0)
  })

  it('ragt es rechts hinaus, rueckt es nach links', () => {
    expect(schubInDieFlaeche({ ...FLAECHE, links: 700, rechts: 940 })).toBe(-48)
  })

  it('ragt es links hinaus, rueckt es nach rechts', () => {
    // Der Befund vom 01.10.2026 ("ypass permissions"): 240 px nach links
    // gehaengt, die ersten Buchstaben abgeschnitten.
    expect(schubInDieFlaeche({ ...FLAECHE, links: -30, rechts: 210 })).toBe(38)
  })

  it('ist es breiter als die Flaeche, gewinnt die linke Kante', () => {
    expect(schubInDieFlaeche({ grenzeLinks: 0, grenzeRechts: 200, luft: 8, links: 50, rechts: 350 })).toBe(-42)
  })
})

describe('GitHub #149: eine Einheit, egal wie die Engine misst', () => {
  /* Die Bilder von a user, nachgerechnet. Fenster 1242x1410 sichtbare Pixel,
   * App unter zoom 1,15, der Ausloeser der Modellauswahl sichtbar von
   * y=1333 bis y=1363 und x=592 bis x=840.
   *
   * Sein WebKitGTK liefert den Kasten in den Pixeln des gezoomten Elements
   * (sichtbar durch 1,15), Chromium und neues WebKit in sichtbaren Pixeln.
   * `window.innerHeight` ist in beiden sichtbar. */
  const FENSTER = { fensterBreite: 1242, fensterHoehe: 1410 }
  const SICHTBAR = { top: 1333, bottom: 1363, left: 592, right: 840 }
  const ALT = { zoom: 1.15, verhaeltnis: 1, ...FENSTER }
  const NEU = { zoom: 1.15, verhaeltnis: 1.1494, ...FENSTER }
  const durch = (k: typeof SICHTBAR, f: number) => ({ top: k.top / f, bottom: k.bottom / f, left: k.left / f, right: k.right / f })

  const lage = (m: typeof ALT, roh: typeof SICHTBAR) => {
    const { kasten, fenster } = lokaleMasse(m)
    return festeLage({
      anker: kasten(roh), fenster, breite: 220, inhaltHoehe: 152,
      ausrichtung: 'rechts', abstand: 4, luft: 8,
    })
  }

  it('der Faktor ist der Zoom oder 1, nichts dazwischen', () => {
    expect(kastenFaktor(1.15, 1.1494)).toBe(1.15)
    expect(kastenFaktor(1.15, 1.127)).toBe(1.15)
    expect(kastenFaktor(1.15, 1)).toBe(1)
    expect(kastenFaktor(1, 1)).toBe(1)
  })

  it('DER FEHLER: im hohen Fenster geht die Liste nach oben auf, nicht unter den Rand', () => {
    // Vorher: 1410 - 1185 - 12 = 213 "freie" Pixel unter dem Ausloeser, wo
    // in Wahrheit (1410 - 1363) / 1,15 - 12 = 28 waren. Die Liste ging nach
    // unten auf und lag unter dem Fensterrand.
    const l = lage(ALT, durch(SICHTBAR, 1.15))
    expect(l.nachOben).toBe(true)
    expect(l.top).toBeUndefined()
    // Unterkante 4 px ueber dem Ausloeser: (1410 - 1333) / 1,15 + 4.
    expect(l.bottom).toBeCloseTo(77 / 1.15 + 4, 5)
    expect(l.maxHoehe).toBe(Math.floor(1333 / 1.15 - 12))
  })

  it('und beide Messarten kommen auf dieselbe Lage', () => {
    const alt = lage(ALT, durch(SICHTBAR, 1.15))
    const neu = lage(NEU, SICHTBAR)
    expect(neu.nachOben).toBe(alt.nachOben)
    expect(neu.bottom).toBeCloseTo(alt.bottom ?? NaN, 5)
    expect(neu.right).toBeCloseTo(alt.right ?? NaN, 5)
    expect(neu.minWidth).toBeCloseTo(alt.minWidth, 5)
    expect(neu.maxHoehe).toBe(alt.maxHoehe)
  })

  it('rechts ausgerichtet haengt sie an der rechten Kante des Ausloesers', () => {
    // Vorher stand sie 183 px zu weit links (rechte Kante bei 657 statt 840).
    const l = lage(NEU, SICHTBAR)
    expect(l.right).toBeCloseTo((1242 - 840) / 1.15, 5)
    expect(l.left).toBeUndefined()
    expect(l.maxWidth).toBeCloseTo(1242 / 1.15 - (1242 - 840) / 1.15 - 8, 5)
  })

  it('im 400 px hohen Fenster bleibt sie bedienbar: oben, gekuerzt, im Fenster', () => {
    // Ausloeser unten im Fenster, die Liste will mit "Older models" und
    // Marken 336 px. Ueber dem Ausloeser sind 330 / 1,15 - 12 = 274.
    const { kasten, fenster } = lokaleMasse({ zoom: 1.15, verhaeltnis: 1.15, fensterBreite: 900, fensterHoehe: 400 })
    const l = festeLage({
      anker: kasten({ top: 330, bottom: 360, left: 500, right: 720 }), fenster,
      breite: 220, inhaltHoehe: 336, ausrichtung: 'rechts', abstand: 4, luft: 8,
    })
    expect(l.nachOben).toBe(true)
    expect(l.maxHoehe).toBe(274)
    // Oberkante in sichtbaren Pixeln: nie ueber dem Fenster.
    const oberkante = 400 - ((l.bottom ?? 0) + l.maxHoehe) * 1.15
    expect(oberkante).toBeGreaterThanOrEqual(8)
  })

  it('links ausgerichtet rueckt sie ins Fenster, wenn sie rechts hinausragte', () => {
    const { kasten, fenster } = lokaleMasse({ zoom: 1, verhaeltnis: 1, fensterBreite: 900, fensterHoehe: 600 })
    const l = festeLage({
      anker: kasten({ top: 100, bottom: 130, left: 780, right: 880 }), fenster,
      breite: 260, inhaltHoehe: 100, ausrichtung: 'links', abstand: 4, luft: 8,
    })
    expect(l.left).toBe(900 - 8 - 260)
    expect(l.top).toBe(134)
    expect(l.nachOben).toBe(false)
  })
})

describe('die Aufklappmenues der App benutzen diese Rechnung wirklich', () => {
  const lies = (...teile: string[]) => readFileSync(resolve(__dirname, '..', '..', ...teile), 'utf8')
  const HAKEN = lies('hooks', 'usePopoverPlatz.ts')

  it('der Haken misst gegen die abschneidende Flaeche, nicht nur gegen das Fenster', () => {
    // `window.innerHeight` liegt im Chat 9 px unter der Kante, die wirklich
    // schneidet (`<main>` mit overflow-hidden). Wer dagegen rechnet, laesst
    // genau diese 9 px durchgehen.
    expect(HAKEN).toContain('abschneidendeFlaeche')
    expect(HAKEN).toMatch(/overflowY === 'visible'/)
    expect(HAKEN).toContain('platzFuerPopover')
    expect(HAKEN).toContain('lokaleMasse')
  })

  it('keine eigene Rechnung mehr neben dem Haken', () => {
    // Jedes dieser Bauteile hatte seine eigene Vorstellung vom Platz. Steht
    // `window.innerHeight` wieder in einem davon, ist die zweite Rechnung
    // zurueck, und mit ihr die zweite Masseinheit.
    for (const datei of [
      ['components', 'create', 'ui', 'Select.tsx'],
      ['components', 'create', 'ui', 'Tooltip.tsx'],
      ['components', 'chat', 'ContextDropdown.tsx'],
      ['components', 'models', 'ModelSelector.tsx'],
      ['components', 'chat', 'CodexModeDropdown.tsx'],
      ['components', 'chat', 'PluginsDropdown.tsx'],
      ['components', 'chat', 'SamplingControls.tsx'],
    ]) {
      const src = lies(...datei)
      expect(src, datei.join('/')).toContain('usePopoverPlatz')
      expect(src, datei.join('/')).not.toContain('window.innerHeight')
    }
  })

  it('die Richtung steht nicht mehr fest im Klassennamen', () => {
    // DER Fehler vom 07.09., buchstaeblich: `top-full` ohne Alternative.
    expect(lies('components', 'chat', 'ContextDropdown.tsx'))
      .toMatch(/nachOben \? 'bottom-full mb-1' : 'top-full mt-1'/)
    expect(lies('components', 'chat', 'ContextDropdown.tsx')).toContain('overflow-y-auto')
  })

  it('KEINE Mindesthoehe in der Modellauswahl, weder im Chat noch in Create', () => {
    // Create hielt 80 px fest, der Chat 200. Beides ist die Zusage, bei
    // genug Enge ueber die Kante zu laufen.
    expect(lies('components', 'create', 'ui', 'Select.tsx')).not.toMatch(/Math\.max\(\s*(64|80)/)
    expect(lies('components', 'models', 'ModelSelector.tsx')).not.toContain('Math.max(200')
  })
})
