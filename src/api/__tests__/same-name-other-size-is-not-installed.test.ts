/**
 * Eine gleichnamige Datei in anderer Groesse ist nicht das Modell (Opus-
 * Endpruefung 02.10.2026). comfyicu's Kopie des Gemma-Encoders heisst wie das
 * Original und ist 2412 Byte groesser. check_model_sizes meldet "vollstaendig"
 * ab 50 % der Katalogschaetzung, und der Install ueberspringt jede Datei, die
 * so gemeldet wird. Dort, wo der Katalog die Bytes genau kennt (sizeBytes),
 * zaehlt nur die genaue Groesse.
 *
 * Run: npx vitest run src/api/__tests__/same-name-other-size-is-not-installed.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  fetchExternal: vi.fn(),
}))
vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  readComfyFolderLists: async () => ({}),
  filterPartialFiles: async (names: string[]) => new Set(names),
  refreshComfyModels: async () => true,
}))

import { getVideoBundles } from '../model-bundles'

let d: typeof import('../discover')
beforeAll(async () => {
  ;(globalThis as unknown as { window: EventTarget }).window = new EventTarget()
  d = await import('../discover')
})

const bundle = () => getVideoBundles().find((b) => b.name === 'LTX 2.5 · Video with Sound')!
const encoder = () => bundle().files.find((f) => f.subfolder === 'text_encoders')!

/** What the disk holds: every file at its exact size, except the ones overridden. */
function disk(override: Record<string, number> = {}) {
  backendCall.mockImplementation(async (cmd, args) => {
    if (cmd !== 'check_model_sizes') return { status: 'started', id: 'x', fits: true }
    const files = (args as { files: Array<{ filename: string; expectedBytes: number }> }).files
    return files.map((f) => {
      const actual = override[f.filename] ?? bundle().files.find((b) => b.filename === f.filename)?.sizeBytes ?? f.expectedBytes
      return { filename: f.filename, exists: true, actualBytes: actual, complete: actual >= f.expectedBytes * 0.5 }
    })
  })
}

beforeEach(() => { backendCall.mockReset() })

describe('onDiskMatchesCatalog', () => {
  it('ohne genaue Katalogzahl gilt die bisherige Meldung, mit ihr nur die genaue Groesse', () => {
    expect(d.onDiskMatchesCatalog({}, { complete: true, actualBytes: 1 })).toBe(true)
    expect(d.onDiskMatchesCatalog({ sizeBytes: 100 }, { complete: true, actualBytes: 100 })).toBe(true)
    expect(d.onDiskMatchesCatalog({ sizeBytes: 100 }, { complete: true, actualBytes: 102 })).toBe(false)
    expect(d.onDiskMatchesCatalog({ sizeBytes: 100 }, { complete: false, actualBytes: 100 })).toBe(false)
    expect(d.onDiskMatchesCatalog({ sizeBytes: 100 }, undefined)).toBe(false)
  })

  it('jede LTX-2.5-Datei des Katalogs kennt ihre Bytes', () => {
    for (const f of bundle().files) expect(f.sizeBytes, f.filename).toBeGreaterThan(0)
  })
})

describe('die Karte', () => {
  it('steht auf "installiert", wenn jede Datei genau stimmt', async () => {
    disk()
    expect((await d.checkBundlesInstalled([bundle()]))[bundle().name]).toBe(true)
    expect(await d.checkBundleInstalled(bundle())).toBe(true)
  })

  it('bietet Get wieder an, wenn der Encoder 2412 Byte zu gross ist (comfyicu-Kopie)', async () => {
    disk({ [encoder().filename!]: encoder().sizeBytes! + 2412 })
    expect((await d.checkBundlesInstalled([bundle()]))[bundle().name]).toBe(false)
    expect(await d.checkBundleInstalled(bundle())).toBe(false)
  })
})

describe('der Install', () => {
  it('ueberspringt die genaue Datei und holt die gleichnamige fremde neu (mit Pruefsumme)', async () => {
    disk({ [encoder().filename!]: encoder().sizeBytes! + 2412 })
    await d.installBundleComplete(bundle()).catch(() => { /* node packs, restart: not under test */ })
    const started = backendCall.mock.calls.filter((c) => c[0] === 'download_model').map((c) => c[1] as Record<string, unknown>)
    expect(started.map((s) => s.filename)).toEqual([encoder().filename])
    expect(started[0].expectedSha256).toBe(encoder().sha256)
  })

  it('startet nichts, wenn alle Dateien genau stimmen', async () => {
    disk()
    await d.installBundleComplete(bundle()).catch(() => {})
    expect(backendCall.mock.calls.filter((c) => c[0] === 'download_model')).toHaveLength(0)
  })
})
