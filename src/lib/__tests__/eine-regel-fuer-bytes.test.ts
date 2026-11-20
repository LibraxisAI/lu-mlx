/**
 * Fund 5, gemessen von Bauer Q auf dem Mac am 11.09.2026: fuer dieselbe Datei,
 * NSFW-gen v2 mit 8.577 Mrd. Bytes, stand in der Downloads-Leiste "8.0 GB" und
 * auf der Katalogkarte "8.6 GB". Zwei Zahlen, derselbe Einheitenname, und
 * keine Chance zu erkennen, dass beide dieselbe Datei meinen.
 *
 * Die Ursache sind zwei Zaehlweisen, nicht zwei Formatierer: die Oberflaeche
 * zaehlt in 1024er-Schritten (`lib/formatters.ts`, und so steht es auch in
 * `api/discover.ts` und `api/model-bundles.ts` geschrieben), der MLX-Katalog in
 * Rust zaehlt in Dezimal-GB und sagt das selbst, indem er seine Groesse mit
 * `size_gb as f64 * 1e9` in Bytes umrechnet (`commands/mlx.rs` beim Pull,
 * `commands/video.rs` bei der Platzpruefung).
 *
 * Die Regel: es gewinnt die Zaehlweise der Oberflaeche, weil jede andere Wahl
 * veroeffentlichte Zahlen verschoben haette. Der Ausreisser wird an der Grenze
 * umgerechnet, dort wo der Katalog gelesen wird.
 *
 * Lauf: npx vitest run src/lib/__tests__/eine-regel-fuer-bytes.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatBytes, downloadSuffix, siGbToBytes } from '../formatters'
import { formatProgressLine } from '../bundle-install'
import { ONBOARDING_MODELS } from '../constants'

/** Die Datei, die Bauer Q gemessen hat, und ihr Katalogeintrag. */
const NSFW_GEN_V2_BYTES = 8_577_000_000
const NSFW_GEN_V2_KATALOG_GB = 8.6

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...(args as [])),
  isMacOS: () => true,
  isTauri: () => true,
}))

describe('eine Zaehlweise fuer Dateigroessen', () => {
  it('die Oberflaeche zaehlt in 1024er-Schritten', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
  })

  it('und die Katalogzahl endet am Rand als Byte-Zahl', () => {
    expect(siGbToBytes(NSFW_GEN_V2_KATALOG_GB)).toBe(8_600_000_000)
    // Gegenkontrolle: die Umrechnung ist messbar und kein Rundungsrauschen.
    // 8.6 als 1024er-Zahl gelesen waere eine halbe Milliarde Bytes mehr.
    expect(Math.abs(siGbToBytes(NSFW_GEN_V2_KATALOG_GB) - NSFW_GEN_V2_KATALOG_GB * 1_073_741_824))
      .toBeGreaterThan(500_000_000)
  })

  it('dieselbe Datei ergibt an allen Stellen denselben Text', () => {
    const erwartet = '8.0 GB'
    // Die Leiste, aus der echten Byte-Zahl.
    expect(formatBytes(NSFW_GEN_V2_BYTES)).toBe(erwartet)
    // Die Karte, aus der Katalogzahl, ueber denselben Formatierer.
    expect(formatBytes(siGbToBytes(NSFW_GEN_V2_KATALOG_GB))).toBe(erwartet)
    // Die zwei weiteren Wege, auf denen eine Byte-Zahl in die Oberflaeche
    // kommt: der Klammerzusatz am Spinner und die Zeile unter der Karte.
    expect(downloadSuffix({ progress: 0, total: NSFW_GEN_V2_BYTES, speed: 0 }))
      .toContain(erwartet)
    expect(formatProgressLine(
      {
        progress: NSFW_GEN_V2_BYTES, total: NSFW_GEN_V2_BYTES, speed: 0,
        filename: 'nsfw-gen-v2.safetensors', status: 'downloading',
      },
      'nsfw-gen-v2.safetensors',
    )).toContain(`${erwartet} of ${erwartet}`)
  })

  it('der Bildkatalog wird beim Lesen umgerechnet, nicht erst beim Zeichnen', async () => {
    backendCall.mockResolvedValueOnce([
      { id: 'nsfw-gen-v2', name: 'NSFW-gen v2', sizeGB: NSFW_GEN_V2_KATALOG_GB, installed: false },
    ])
    const { listMlxImageModels } = await import('../../api/mlx-image')
    const [modell] = await listMlxImageModels()
    expect(modell.sizeBytes).toBe(8_600_000_000)
    expect(formatBytes(modell.sizeBytes)).toBe(formatBytes(NSFW_GEN_V2_BYTES))
  })
})

/**
 * Die zweite Haelfte des Auftrags: tritt dieselbe Zweiteilung auch bei den
 * GGUF-Downloads auf? Gemessen: nein. Der Chat-Katalog zaehlt schon in
 * 1024er-Schritten, und das Startmodell ist die eine Stelle, an der eine echte
 * Byte-Zahl und ein geschriebener Text derselben Datei nebeneinander stehen.
 */
describe('die GGUF-Seite', () => {
  it('Karte und Leiste nennen fuer das Startmodell dieselbe Zahl', () => {
    const starter = ONBOARDING_MODELS.find((m) => m.name === 'qwen2.5-7b')
    expect(starter?.expectedBytes).toBe(4_683_073_920)
    // Die Karte schreibt "4.4 GiB", die Leiste rechnet dieselben Bytes: der
    // Einheitenname ist dort ausgeschrieben, die Zahl ist dieselbe.
    expect(starter?.size).toBe('4.4 GiB')
    expect(formatBytes(starter!.expectedBytes!)).toBe('4.4 GB')
  })

  // Dieselbe Bindung fuer den zweiten Onboarding-Eintrag (Opus-Runde 3,
  // review-onboard9b.md): "5.3 GiB" stand von Hand geschrieben neben
  // expectedBytes, ohne dass ein Test die beiden zusammenhaelt. Jetzt
  // gepinnt wie beim Starter oben.
  it('und fuer den zweiten Eintrag (Qwen 3.5 9B Abliterated) ebenso', () => {
    const nineB = ONBOARDING_MODELS.find((m) => m.name === 'qwen3.5-9b')
    expect(nineB?.expectedBytes).toBe(5_627_045_216)
    expect(nineB?.size).toBe('5.2 GiB')
    expect(formatBytes(nineB!.expectedBytes!)).toBe('5.2 GB')
  })
})

/**
 * Der Waechter gegen eine zweite Rechnung. Zwei gab es: `prettySize` in
 * `LogFileSettings.tsx` (eigene Schwellen, eigene Rundung) und die
 * Inline-Rechnung in `ChatArtifactCard.tsx`. Beide sind fort.
 */
describe('keine zweite Rechnung', () => {
  const WURZEL = resolve(__dirname, '../..')

  function dateien(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules') continue
      const pfad = join(dir, name)
      if (statSync(pfad).isDirectory()) dateien(pfad, out)
      else if (/\.tsx?$/.test(name)) out.push(pfad)
    }
    return out
  }

  /**
   * Nicht mitgezaehlt: der Speicher einer Grafikkarte (`HardwareSettings.tsx`,
   * `memory_mib / 1024` als GB). Eine Karte mit 8 GiB wird von jedem
   * Hersteller als 8-GB-Karte verkauft, und die VRAM-Angaben des Katalogs
   * ("needs 12 GB") sind dieselbe Zaehlweise. Die Regel hier gilt fuer DATEI-
   * und Uebertragungsgroessen.
   */
  const NICHT_DATEIGROESSEN = ['components/settings/HardwareSettings.tsx']

  it('nur formatters.ts rechnet Bytes in Text um', () => {
    // Eine Division durch 1024 mit einer Einheit dahinter im selben Ausdruck:
    // genau die Form, die `prettySize` hatte.
    const muster = /\/\s*1024[^\n]{0,60}(toFixed|Math\.round)[^\n]{0,40}(\bB\b|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/
    // Relative paths with forward slashes: the exemptions below are written
    // that way, and on Windows `join` hands back backslashes.
    const treffer = dateien(WURZEL)
      .map((p) => p.slice(WURZEL.length + 1).replace(/\\/g, '/'))
      .filter((p) => p !== 'lib/formatters.ts')
      .filter((p) => !NICHT_DATEIGROESSEN.includes(p))
      .filter((p) => muster.test(readFileSync(resolve(WURZEL, p), 'utf8')))
    expect(treffer).toEqual([])

    // Positivkontrolle: das Muster findet die Form, wenn es sie gibt.
    expect(muster.test('return `${(bytes / 1024 / 1024).toFixed(1)} MB`')).toBe(true)
  })

  it('und die beiden alten Rechnungen holen ihren Text jetzt dort', () => {
    const log = readFileSync(resolve(WURZEL, 'components/settings/LogFileSettings.tsx'), 'utf8')
    expect(log).toContain("import { formatBytes } from '../../lib/formatters'")
    expect(log).not.toContain('prettySize')
    const karte = readFileSync(resolve(WURZEL, 'components/chat/ChatArtifactCard.tsx'), 'utf8')
    expect(karte).toContain('const sizeLabel = formatBytes(artifact.content.length)')
  })
})
