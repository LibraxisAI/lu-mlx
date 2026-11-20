/**
 * Ein Knopf, der auf einen Reiter fuehrt, nennt ihn beim Namen, den er hat.
 *
 * Seit 02aa2244 heisst der linke Reiter der Models-Seite "Get new". Zwei der
 * drei Knoepfe, die dorthin fuehren, wurden umgestellt, der dritte nicht: wer
 * Models, dann Installed, dann eine Kategorie ohne installierte Modelle
 * oeffnete, bekam "Discover text models" angeboten und suchte danach oben
 * vergeblich. Genau dieser Fehler ist im Bild- und Videoweg schon einmal
 * aufgetreten (src/api/__tests__/der-wegweiser-nennt-echte-reiter.test.ts) und
 * in Fehlermeldungen (src/lib/__tests__/der-rat-nennt-nur-echte-knoepfe.test.ts).
 * Die beiden Waechter lesen Meldungstexte; dieser liest die Knoepfe der Seite
 * selbst.
 *
 * Run: npx vitest run src/components/models/__tests__/der-leere-filter-nennt-den-reiter-den-es-gibt.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const lies = (...teile: string[]) => readFileSync(resolve(__dirname, '..', ...teile), 'utf8')

/** Die Seite: sie entscheidet, welcher Knopf wohin fuehrt und wie er heisst. */
const SEITE = lies('ModelManager.tsx')

/**
 * Die beiden Fassungen der Seite (seit dem 08.10.2026: klassisch auf Windows
 * und Linux, neu auf dem Mac). Jede zeichnet die Reiterleiste selbst, also
 * wird der Name des Reiters in jeder nachgelesen.
 *
 * Die sichtbare Beschriftung ist das, was ein Mensch liest. In der klassischen
 * Fassung steht vor jeder Beschriftung ein Icon, und die Suche haengt an
 * dessen `/>`. Die Reiter der Mac-Fassung tragen nur ihr Wort: der erste Text
 * mit grossem Anfangsbuchstaben hinter einem schliessenden `>`.
 */
const FASSUNGEN = [
  { name: 'klassisch', quelle: lies('skin', 'classic.tsx'), beschriftung: (a: string) => (a.match(/\/>\s*([A-Za-z][A-Za-z ]*)/)?.[1] ?? '').trim() },
  { name: 'Mac', quelle: lies('skin', 'mac.tsx'), beschriftung: (a: string) => (a.match(/>\s*([A-Z][A-Za-z ]*)/)?.[1] ?? '').trim() },
] as const

/** Wie der Reiter `tab` in der Reiterleiste einer Fassung heisst. */
function reiterName(fassung: typeof FASSUNGEN[number], tab: string): string {
  const knopf = fassung.quelle.indexOf(`aria-pressed={tab === '${tab}'}`)
  expect(knopf, `${fassung.name}: kein Reiterknopf fuer ${tab}`).toBeGreaterThan(0)
  // Der Knopf fuehrt auch wirklich auf den Reiter, den er als gedrueckt meldet.
  expect(fassung.quelle.slice(knopf - 80, knopf), `${fassung.name}: ${tab}`).toContain(`onClick={() => onTab('${tab}')}`)
  const name = fassung.beschriftung(fassung.quelle.slice(knopf, fassung.quelle.indexOf('</button>', knopf)))
  expect(name.length).toBeGreaterThan(0)
  return name
}

/**
 * Jeder Knopf der Seite, der auf den Reiter fuehrt, mit seiner Beschriftung.
 * Die Seite reicht Wort und Ziel als ein Paar an die Fassung, die den Knopf
 * zeichnet. Eine Vorlage (`Get new ${...} models`) zaehlt mit ihrem festen
 * Anfang.
 */
function knoepfeZumReiter(tab: string): string[] {
  const muster = new RegExp("label: (['`])([^'`]*)\\1, onClick: \\(\\) => setTab\\('" + tab + "'\\)", 'g')
  return [...SEITE.matchAll(muster)].map((m) => m[2])
}

describe.each(FASSUNGEN)('die Knoepfe der Models-Seite nennen ihre Reiter richtig ($name)', (fassung) => {
  const getNew = reiterName(fassung, 'discover')

  it('der Reiter heisst "Get new"', () => {
    expect(getNew).toBe('Get new')
    expect(reiterName(fassung, 'installed')).toBe('Installed')
  })

  it('alle drei Wege dorthin nennen ihn so', () => {
    const knoepfe = [getNew, ...knoepfeZumReiter('discover')]
    // Der Reiter selbst, der Leerzustand ohne jedes Modell, der Leerzustand
    // eines Kategoriefilters. Faellt einer weg, faellt diese Zahl auf, statt
    // dass ein leeres Ergebnis gruen durchgeht.
    expect(knoepfe).toHaveLength(3)
    for (const k of knoepfe) {
      expect(k, `"${k}" nennt keinen Reiter, den es gibt`).toContain(getNew)
    }
  })

  it('die Fassung zeichnet das Wort, das die Seite ihr reicht, und kein eigenes', () => {
    expect(fassung.quelle).toMatch(/onClick=\{action\.onClick\}[\s\S]{0,400}\{action\.label\}/)
  })

  // NEGATIVKONTROLLE: genau der alte Text muss durchfallen, und "Discover"
  // steht auf keinem Knopf mehr, der irgendwohin fuehrt.
  it('der alte Text waere aufgefallen', () => {
    expect(fassung.beschriftung('<Sparkles size={11} /> Discover {modeMeta.label.toLowerCase()} models'))
      .not.toContain(getNew)
    expect('Discover ${modeMeta.label.toLowerCase()} models').not.toContain(getNew)
    for (const k of knoepfeZumReiter('discover')) {
      expect(k).not.toContain('Discover')
    }
    expect(fassung.quelle).not.toMatch(/>\s*Discover\b/)
  })
})
