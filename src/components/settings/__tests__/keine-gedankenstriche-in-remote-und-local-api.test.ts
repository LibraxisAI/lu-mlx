/**
 * Hausregel: kein Gedankenstrich im Text, den ein Kunde liest. Der Satz wird
 * umgebaut, mit Punkt, Komma oder Doppelpunkt.
 *
 * Box-Test T5 vom 11.09.2026, Nebenfund 1: fuenf Zeichen U+2014 im
 * Oberflaechentext, ueber `charCodeAt` gezaehlt. Einer im Hilfetext von Remote
 * Access, vier im Panel Local API. Alle sind umgeschrieben, dazu ein sechster
 * im LAN-Satz der Local API, den der Tester nicht zu sehen bekam.
 *
 * Der Wachposten haelt genau diese drei Quelldateien. Ein Durchgang ueber das
 * ganze Repo ist ausdruecklich nicht gewollt (der Inhaber hat ihn am 08.09. gestoppt,
 * GitHub #163), und ein Waechter, der mehr behauptet als er traegt, ist
 * schlimmer als keiner. Kommentare bleiben draussen: sie erreichen keinen
 * Leser. Dasselbe Muster haelt im Web-Repo die drei Marketing-Seiten
 * (`public-copy-dashes.test.ts`, Bauer W5).
 *
 * Die Striche stehen hier als Code-Punkte, damit diese Datei nicht ihr eigener
 * erster Fund wird.
 *
 * Run: npx vitest run src/components/settings/__tests__/keine-gedankenstriche-in-remote-und-local-api.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..', '..')

/** Die Oberflaechen des Fundes, je Quelldatei ihres Textes. */
const QUELLEN: Array<[flaeche: string, datei: string]> = [
  ['Settings > Voice & Remote > Local API', join('components', 'settings', 'LocalApiSettings.tsx')],
  ['die Saetze der Local API', join('lib', 'local-api.ts')],
  ['Settings > Voice & Remote > Remote Access, How it works', join('components', 'settings', 'RemoteAccessDocs.tsx')],
]

/** Quelltext ohne Kommentare: nur was den Leser erreicht, zaehlt. */
function ausgeliefert(datei: string): string {
  return readFileSync(join(SRC, datei), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const STRICHE = ['\u2014', '\u2013']

describe('die Texte aus T5 tragen keinen Gedankenstrich', () => {
  for (const [flaeche, datei] of QUELLEN) {
    it(`${flaeche} kommt ohne aus`, () => {
      const gefunden = [...ausgeliefert(datei)].filter((c) => STRICHE.includes(c))
      expect(gefunden, `${gefunden.length} Strich(e) in ${datei}`).toEqual([])
    })
  }

  it('POSITIVKONTROLLE: die Suche findet beide Striche, wenn sie dastehen', () => {
    // Ohne sie koennte der Waechter an einem kaputten Muster blind sein und
    // trotzdem gruen melden.
    const probe = 'a \u2014 b \u2013 c'
    expect([...probe].filter((c) => STRICHE.includes(c))).toHaveLength(2)
  })

  it('POSITIVKONTROLLE: ein Strich im Kommentar zaehlt nicht, einer im Text schon', () => {
    const mitKommentar = ausgeliefert(join('lib', 'local-api.ts'))
    expect(mitKommentar).not.toContain('Die lokale Modell-API')
    expect(mitKommentar).toContain('No web page may read this API')
  })
})

/**
 * R2-29: der Erklaertext versprach Shell hinter dem Filesystem-Schalter.
 *
 * "Lets the remote agent read and write files AND RUN SHELL COMMANDS in the
 * dispatched working folder" stand unter dem Dateizugriff. Der Schalter macht
 * das nicht, dafuer gibt es den vierten Punkt weiter unten, und ein Nutzer, der
 * bewusst nur Dateizugriff geben wollte, las hier, er gebe damit auch die
 * Shell. Die Rust-Seite bleibt unangetastet, der Text war falsch, nicht die
 * Trennung.
 */
describe('R2-29: der Dateischalter verspricht keine Shell', () => {
  const docs = () => ausgeliefert(join('components', 'settings', 'RemoteAccessDocs.tsx'))

  it('nennt shell commands nur noch im vierten Punkt', () => {
    const quelle = docs()
    expect([...quelle.matchAll(/run shell commands/g)]).toHaveLength(1)
    const dateiteil = quelle.slice(
      quelle.indexOf('Filesystem Access'),
      quelle.indexOf('Downloads &amp; Installs'),
    )
    expect(dateiteil, 'der Dateischalter verspricht weiter die Shell')
      .not.toContain('shell')
    expect(dateiteil).toContain('read and write files in the dispatched working folder')
  })

  it('NEGATIVKONTROLLE: der vierte Punkt bleibt wortgleich', () => {
    expect(docs()).toContain('Lets the remote device run shell commands and code on this machine.')
  })
})
