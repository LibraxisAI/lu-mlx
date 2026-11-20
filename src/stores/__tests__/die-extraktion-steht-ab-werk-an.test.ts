/**
 * R5-27 und R2-48, Entscheid vom 12.09.2026: die automatische
 * Erinnerungs-Extraktion steht ab Werk AN.
 *
 * Drei Tore standen davor, und im Desktop war das dritte still zu. Die zwei
 * Schalter in den Erinnerungseinstellungen standen auf an, das Kostentor
 * `memoryCloudOptIn` stand auf aus, und es gab keine Oberflaeche, die es
 * geoeffnet haette. Auf LU Cloud lief die Extraktion damit nie, und niemand
 * konnte das merken: eine Funktion, die nichts tut, meldet sich nicht.
 *
 * Der zweite Test ist die Grenze des Entscheids. Nur NEUE Profile bekommen die
 * Vorgabe. Die Migration wird nicht angefasst, sie bleibt rein additiv, und
 * ein Profil, in dem der alte Wert steht, behaelt ihn. Ein Einmal-Reset waere
 * genau der Fehler aus v10 und v19 (DOWNGRADE-KONTRAKT).
 *
 * Run: npx vitest run src/stores/__tests__/die-extraktion-steht-ab-werk-an.test.ts
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { silentCallAllowed } from '../../lib/silent-model-calls'
import { useMemoryStore } from '../memoryStore'
import { useSettingsStore } from '../settingsStore'

describe('die automatische Erinnerungs-Extraktion', () => {
  it('steht bei einem frischen Profil an, auch auf LU Cloud', () => {
    const settings = useMemoryStore.getState().settings
    expect(settings.autoExtractEnabled, 'der Hauptschalter').toBe(true)
    expect(settings.autoExtractInAllModes, 'ausserhalb des Agentenmodus').toBe(true)
    expect(DEFAULT_SETTINGS.memoryCloudOptIn, 'das Kostentor auf LU Cloud').toBe(true)
    // Das Tor ist die Stelle, an der es im Desktop still endete.
    expect(silentCallAllowed('lu-cloud', DEFAULT_SETTINGS.memoryCloudOptIn)).toBe(true)
    // Und die eigene Maschine war nie betroffen: dort gab es nie eine Rechnung.
    expect(silentCallAllowed('ollama', false)).toBe(true)
  })

  it('laesst ein bestehendes Profil bei seinem eigenen Wert', () => {
    const migrate = useSettingsStore.persist.getOptions().migrate
    expect(migrate, 'die Migration ist weg').toBeTypeOf('function')
    const alt = migrate!(
      { settings: { ...DEFAULT_SETTINGS, memoryCloudOptIn: false }, personas: [] },
      21,
    ) as { settings: { memoryCloudOptIn: boolean } }
    expect(alt.settings.memoryCloudOptIn, 'die Migration hat den Wert ueberschrieben').toBe(false)
  })
})
