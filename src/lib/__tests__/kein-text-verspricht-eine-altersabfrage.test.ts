/**
 * Kein Kundentext kuendigt eine Altersbestaetigung an, die nicht kommt.
 *
 * Entscheid vom 13.09.2026: fuer 3.0.0 faellt der Bestaetigungsschritt
 * weg, in 3.0.1 kommt er wieder. Die Stellung steht im Server
 * (`AGE_CONFIRMATION_REQUIRED`), die Oberflaeche folgt ihr zur Laufzeit. Die
 * TEXTE koennen das nicht: sie sind gedruckt und muessen beschreiben, was der
 * Kunde in diesem Release wirklich sieht.
 *
 * Deshalb trennt dieser Waechter zwei Dinge, die leicht verwechselt werden:
 * die Oberflaeche DARF die Saetze weiter tragen, weil sie sie nur zeigt, wenn
 * der Server den Schritt verlangt. Die gedruckten Texte duerfen es nicht.
 *
 * Nie geschwaecht und hier ausdruecklich mitgeprueft: die zwei Zeilen, die
 * keine Einstellung bewegt, und die drei Stufen.
 *
 * Lauf: npx vitest run src/lib/__tests__/kein-text-verspricht-eine-altersabfrage.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const WURZEL = resolve(__dirname, '..', '..', '..')
const lies = (pfad: string) => readFileSync(resolve(WURZEL, pfad), 'utf8')

/** Ein Text verspricht eine Abfrage, wenn er sie ankuendigt. */
const versprichtAbfrage = (text: string) =>
  /\b18 or older\b/i.test(text)
  || /age confirmation/i.test(text)
  || /confirm(?:ing)? (?:that )?you are 18/i.test(text)
  || /Age confirmed on/i.test(text)

const GEDRUCKTE_TEXTE = [
  'src/lib/release-notes.ts',
  'docs/index.html',
  'docs/pricing/index.html',
  'docs/cloud/index.html',
  'docs/guide/cloud/index.html',
] as const

/** Nur der Abschnitt der laufenden Version; aeltere bleiben, wie sie sind. */
function changelogAbschnitt(): string {
  const teil = lies('CHANGELOG.md').split(/^## \[/m).find((t) => t.startsWith('3.0.0]'))
  expect(teil, 'CHANGELOG fuehrt keinen 3.0.0-Abschnitt').toBeTruthy()
  return teil!
}

describe('die Altersbestaetigung in den Texten', () => {
  it('wird in keinem gedruckten Kundentext angekuendigt', () => {
    for (const datei of GEDRUCKTE_TEXTE) {
      expect(versprichtAbfrage(lies(datei)), `${datei} kuendigt eine Altersabfrage an`).toBe(false)
    }
  })

  it('und auch nicht im Abschnitt der laufenden Version', () => {
    expect(versprichtAbfrage(changelogAbschnitt())).toBe(false)
  })

  it('aber die Oberflaeche behaelt ihre Saetze, weil sie sie nur bedingt zeigt', () => {
    // Die Gegenprobe zur Regel darueber. Faellt sie, ist der Schritt nicht
    // abgeschaltet, sondern ausgebaut, und 3.0.1 muesste ihn neu schreiben.
    const oberflaeche = lies('src/components/settings/ContentPolicySettings.tsx')
    expect(oberflaeche).toContain('I am 18 or older')
    expect(oberflaeche).toContain('Requires an age confirmation.')
    expect(oberflaeche, 'der Satz haengt nicht mehr an der Schalterstellung')
      .toContain('bestaetigungNoetig')
    expect(oberflaeche).toContain("o.value === 'off' && requiresAge")
  })

  it('und die zwei Zeilen, die keine Einstellung bewegt, stehen unveraendert', () => {
    for (const datei of ['docs/pricing/index.html', 'src/lib/release-notes.ts'] as const) {
      const text = lies(datei)
      expect(text, datei).toContain('aterial involving minors is refused on every request')
      expect(text, datei).toContain('ou may not upload a photograph of a real, identifiable person without their consent')
    }
  })

  it('und die drei Stufen heissen weiter Strict, Standard und Off', () => {
    for (const datei of ['src/lib/release-notes.ts', 'docs/index.html'] as const) {
      expect(lies(datei), datei).toMatch(/Strict, Standard, or off/)
    }
    const oberflaeche = lies('src/components/settings/ContentPolicySettings.tsx')
    for (const stufe of ["label: 'Strict'", "label: 'Standard'", "label: 'Off'"]) {
      expect(oberflaeche).toContain(stufe)
    }
  })

  /** NEGATIVKONTROLLE: die Erkennung greift wirklich. */
  it('erkennt die alten Saetze', () => {
    expect(versprichtAbfrage('Strict, Standard, or off after you confirm you are 18 or older.')).toBe(true)
    expect(versprichtAbfrage('Off requires an age confirmation in the same step.')).toBe(true)
    expect(versprichtAbfrage('Age confirmed on 10.09.2026.')).toBe(true)
    expect(versprichtAbfrage('Strict, Standard, or off. It applies to cloud image and video.')).toBe(false)
  })
})
