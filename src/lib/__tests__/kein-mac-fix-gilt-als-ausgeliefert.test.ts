/**
 * Kein Mac-Fix gilt als ausgeliefert.
 *
 * 3.0.0 baut Windows und Linux. Die Matrix von `build-tauri` in
 * `.github/workflows/release.yml` fuehrt keine macOS-Strecke. Der Mac-Bau der
 * spaeteren Versionen laeuft im eigenen Job `build-tauri-macos`, der nicht in
 * dieser Matrix steht; an der Aussage ueber 3.0.0 aendert er nichts. Der Eintrag
 * zu GitHub 127 beschrieb die Reparatur des MLX-Schnappschusses trotzdem wie
 * eine erledigte Sache. Genau der Melder haette in 3.0.0 nachgesehen und nichts
 * gefunden, weil es fuer seine Maschine gar keinen Bau gibt: die Aenderung liegt
 * im Quelltext, nicht in einer Auslieferung.
 *
 * Gezaehlt, nicht getippt: ob ein Mac-Bau ausgeliefert wird, steht in
 * release.yml und wird hier von dort gelesen. Kommt die Strecke zurueck, wird
 * dieser Waechter rot und der Hinweis gehoert neu geprueft, statt still falsch
 * zu werden.
 *
 * Windows und Linux sind unberuehrt: sie haben eine Strecke, ihre Eintraege
 * brauchen keinen Hinweis.
 *
 * Lauf: npx vitest run src/lib/__tests__/kein-mac-fix-gilt-als-ausgeliefert.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const WURZEL = resolve(__dirname, '..', '..', '..')
const lies = (pfad: string) => readFileSync(resolve(WURZEL, pfad), 'utf8')

/** Die Bauplattformen der Auslieferung, aus ihrer Matrix gelesen. */
const bauPlattformen = (): string[] => {
  const ohneKommentare = lies('.github/workflows/release.yml')
    .split('\n')
    .filter((zeile) => !/^\s*#/.test(zeile))
    .join('\n')
  return [...ohneKommentare.matchAll(/^\s*- platform:\s*(\S+)/gm)].map((treffer) => treffer[1])
}

const abschnitt300 = (): string => {
  const teil = lies('CHANGELOG.md')
    .split(/^## \[/m)
    .find((stueck) => stueck.startsWith('3.0.0]'))
  expect(teil, 'CHANGELOG fuehrt keinen 3.0.0-Abschnitt').toBeTruthy()
  return teil!
}

/** Ein Eintrag ist ein Aufzaehlungspunkt, der fett beginnt. */
const punkte = (text: string): string[] =>
  text.split(/\n(?=- \*\*)/).filter((stueck) => stueck.startsWith('- **'))

/**
 * Beschreibt der Eintrag die Mac-Strecke? MLX laeuft nur dort, und ein Eintrag,
 * der macOS nennt, redet ohnehin darueber.
 */
const betrifftDieMacStrecke = (eintrag: string): boolean =>
  /\bMLX\b/.test(eintrag) || /\bmacOS\b/i.test(eintrag)

/**
 * Nennt der Eintrag die Plattform ausdruecklich? "MLX" allein reicht nicht: wer
 * das Kuerzel nicht kennt, liest den Eintrag als allgemeine Reparatur.
 */
const nenntDiePlattform = (eintrag: string): boolean => /\bmacOS\b/i.test(eintrag)

/**
 * Sagt der Eintrag, dass dieses Release den Mac-Bau nicht liefert? An der
 * Aussage erkannt, nicht an einem festen Satz.
 */
const nenntDenFehlendenMacBau = (eintrag: string): boolean =>
  /\bno Mac build\b/i.test(eintrag)
  || /\bnot in this release\b/i.test(eintrag)
  || /\bbuilds Windows and Linux\b/i.test(eintrag)

describe('kein Mac-Fix gilt als ausgeliefert', () => {
  it('3.0.0 liefert Windows und Linux, keinen Mac', () => {
    const plattformen = bauPlattformen()
    expect(plattformen.length, 'die Baumatrix in release.yml ist nicht lesbar').toBeGreaterThan(0)
    expect(
      plattformen.filter((name) => /mac/i.test(name)),
      'release.yml baut wieder fuer macOS: die Hinweise im CHANGELOG gehoeren neu geprueft',
    ).toEqual([])
  })

  it('jeder Mac-Eintrag nennt die Plattform und sagt, dass dieser Bau fehlt', () => {
    const macEintraege = punkte(abschnitt300()).filter(betrifftDieMacStrecke)
    // Ohne diese Zeile waere der Waechter gruen, sobald niemand mehr MLX oder
    // macOS nennt, auch wenn der Eintrag nur umbenannt wurde.
    expect(macEintraege.length, 'kein Mac-Eintrag gefunden, der Waechter liefe ins Leere')
      .toBeGreaterThan(0)
    for (const eintrag of macEintraege) {
      expect(
        nenntDiePlattform(eintrag),
        `dieser Eintrag nennt die Plattform nicht: ${eintrag.slice(0, 90)}`,
      ).toBe(true)
      expect(
        nenntDenFehlendenMacBau(eintrag),
        `dieser Eintrag liest sich als ausgeliefert: ${eintrag.slice(0, 90)}`,
      ).toBe(true)
    }
  })

  /**
   * NEGATIVKONTROLLE. Die alte Fassung muss durchfallen, sonst prueft der
   * Waechter nichts, und der Eintrag ueber die Webseite darf nicht mitgerissen
   * werden: er nimmt eine Zusage zurueck, statt eine zu geben.
   */
  it('erkennt die alte Fassung und verwechselt sie mit nichts', () => {
    const alteFassung =
      '- **The image install that finished at the promised size with two empty folders'
      + ' is repaired.** The installer now reads the file list and the required set from'
      + ' the repository itself. This is GitHub 127.'
    expect(nenntDenFehlendenMacBau(alteFassung)).toBe(false)

    const neueFassung =
      '- **The MLX image install ...: the fix is in the source, not in this release.**'
      + ' MLX runs on macOS only, and 3.0.0 builds Windows and Linux.'
    expect(nenntDenFehlendenMacBau(neueFassung)).toBe(true)

    // Der Eintrag ueber die Webseite nennt einen Mac-Bau, verspricht aber keinen.
    const webseite =
      '- **locallyuncensored.com no longer promises a Mac build**, and two'
      + ' documentation pages give the video model count of the current catalogue.'
    expect(betrifftDieMacStrecke(webseite), 'der Webseiten-Eintrag wird gar nicht geprueft')
      .toBe(false)
    // Und MLX allein genuegt nicht, die Plattform muss dastehen.
    expect(nenntDiePlattform('- **The MLX image install is not in this release.**')).toBe(false)
  })
})
