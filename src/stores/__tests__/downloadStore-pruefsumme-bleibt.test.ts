/**
 * Die Pruefsumme gilt nicht nur beim ersten Versuch (Opus-Endpruefung 02.10.2026).
 *
 * Retry und Resume lesen nur den Meta-Eintrag des Stores. Wurde er ohne sha256
 * geschrieben (Installationspfade, die sie vergassen, oder ein gespeicherter
 * Eintrag von frueher), startete ein Retry nach einem Hash-Fehler dieselbe
 * Datei ohne Pruefsumme, und eine vom Spiegel ausgetauschte Datei wurde
 * ungeprueft installiert. Jetzt fuellt der Store fehlende Werte aus dem Katalog
 * auf, wenn der Katalog dieselbe Adresse nennt.
 *
 * Gegen den ECHTEN Katalog und den echten Store; nur der Rust-Aufruf ist Attrappe.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-pruefsumme-bleibt.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => ({}) as unknown)
vi.mock('../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/backend')>()),
  backendCall: (cmd: string, args?: Record<string, unknown>) => backendCall(cmd, args),
}))

import { useDownloadStore } from '../downloadStore'
import { getVideoBundles } from '../../api/model-bundles'
import { downloadBundleFiles } from '../../lib/bundle-install'

const ltx = () => getVideoBundles().find((b) => b.name === 'LTX 2.5 · Video with Sound')!
const dit = () => ltx().files[0]
const callsOf = (cmd: string) => backendCall.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>)

beforeEach(() => {
  backendCall.mockClear()
  backendCall.mockImplementation(async (cmd: string) => (cmd === 'download_progress' ? {} : ({} as unknown)))
  useDownloadStore.setState({ downloads: {}, downloadMeta: {}, orphans: {} })
  useDownloadStore.getState().stopPolling()
})

describe('der Katalog liefert Pruefsumme und Bytes nach', () => {
  it('setMeta ohne Zusatzwerte bekommt die sha256 der Katalogdatei', () => {
    const f = dit()
    useDownloadStore.getState().setMeta(f.filename!, f.downloadUrl!, f.subfolder!)
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(useDownloadStore.getState().downloadMeta[f.filename!]).toMatchObject({
      sha256: f.sha256, expectedBytes: Math.round(f.sizeGB! * 1_073_741_824),
    })
  })

  it('eine gleichnamige Datei von einer ANDEREN Adresse erbt keine fremde Pruefsumme', () => {
    const f = dit()
    useDownloadStore.getState().setMeta(f.filename!, 'https://example.test/other.safetensors', 'diffusion_models')
    expect(useDownloadStore.getState().downloadMeta[f.filename!].sha256).toBeUndefined()
  })
})

describe('Retry und Resume nach einem Hash-Fehler schicken den Hash wieder mit', () => {
  const hashFehler = 'SHA-256 mismatch: the downloaded file is not the one the catalog pinned'

  it('Retry: auch wenn der Eintrag ohne sha256 geschrieben wurde', async () => {
    const f = dit()
    useDownloadStore.setState({
      downloads: { [f.filename!]: { progress: 5, total: 10, speed: 0, filename: f.filename!, status: 'error', error: hashFehler } },
      // So sah ein von einem Installationspfad ohne Zusatzwerte geschriebener Eintrag aus.
      downloadMeta: { [f.filename!]: { url: f.downloadUrl!, subfolder: f.subfolder! } },
    })
    await useDownloadStore.getState().retry(f.filename!)
    const started = callsOf('download_model')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ filename: f.filename, expectedSha256: f.sha256 })
    expect(started[0].expectedBytes).toBe(Math.round(f.sizeGB! * 1_073_741_824))
    useDownloadStore.getState().stopPolling()
  })

  it('Resume: ebenso', async () => {
    const f = dit()
    useDownloadStore.setState({
      downloadMeta: { [f.filename!]: { url: f.downloadUrl!, subfolder: f.subfolder! } },
    })
    await useDownloadStore.getState().resume(f.filename!)
    const resumed = callsOf('resume_download')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({ id: f.filename, expectedSha256: f.sha256 })
    useDownloadStore.getState().stopPolling()
  })

  it('ganz ohne Eintrag fragt Retry weiter den Katalog (wie bisher)', async () => {
    const f = dit()
    await useDownloadStore.getState().retry(f.filename!)
    expect(callsOf('download_model')[0]).toMatchObject({ expectedSha256: f.sha256 })
    useDownloadStore.getState().stopPolling()
  })
})

describe('der erste Start schickt die Pruefsumme ebenfalls mit', () => {
  it('downloadBundleFiles (Create-Installation) gibt sha256 und Bytes an den Start', async () => {
    const f = dit()
    const start = vi.fn(async () => ({ status: 'exists' }))
    await downloadBundleFiles(
      [{ filename: f.filename!, subfolder: f.subfolder!, downloadUrl: f.downloadUrl!, sizeGB: f.sizeGB, sha256: f.sha256 }],
      { start, progress: async () => ({}) },
    )
    expect(start).toHaveBeenCalledWith(f.downloadUrl, f.subfolder, f.filename, Math.round(f.sizeGB! * 1_073_741_824), f.sha256)
  })
})
