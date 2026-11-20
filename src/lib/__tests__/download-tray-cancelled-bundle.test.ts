/**
 * The box, 03.10.2026: three of the five files of "LTX 2.5 · Small (GGUF Q4)"
 * were cancelled, and the tray then said "Complete (2 files)" with a green
 * check. The two finished files were all the tray still knew of the bundle, so
 * "every row is complete" was true and meant nothing. The tray now keeps the
 * cancelled files with their bundle and says what is done and what is not.
 *
 * Run: npx vitest run src/lib/__tests__/download-tray-cancelled-bundle.test.ts
 */
import { describe, it, expect } from 'vitest'
import { trayBundles, bundleVerdict } from '../download-tray'

const LTX = 'LTX 2.5 · Small (GGUF Q4)'
const FILES = [
  'ltx-2.5-22b-distilled-transformer-bf16-Q4_K_M.gguf',
  'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
  'ltx-2.5-video-vae-bf16.safetensors',
  'ltx-2.5-audio-vae-bf16.safetensors',
  'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
]
const bundleMap = Object.fromEntries(FILES.map((f) => [f, LTX]))
const row = (filename: string, status: string) => ({ progress: 1, total: 1, speed: 0, filename, status })

describe('a bundle with cancelled files', () => {
  it('is not complete: the tray says what finished and what was cancelled', () => {
    const rows = { [FILES[3]]: row(FILES[3], 'complete'), [FILES[4]]: row(FILES[4], 'complete') }
    const [group] = trayBundles(rows, bundleMap, FILES.slice(0, 3))
    expect(group.name).toBe(LTX)
    expect(group.files.map((f) => f.id)).toEqual([FILES[3], FILES[4]])
    expect(group.cancelled).toEqual(FILES.slice(0, 3))
    expect(bundleVerdict(group)).toEqual({ state: 'partial', line: '2 of 5 files downloaded, 3 cancelled' })
  })

  it('one finished file and one cancelled reads in the singular', () => {
    const rows = { 'a.safetensors': row('a.safetensors', 'complete') }
    const [group] = trayBundles(rows, { 'a.safetensors': 'Pair', 'b.safetensors': 'Pair' }, ['b.safetensors'])
    expect(bundleVerdict(group).line).toBe('1 of 2 files downloaded, 1 cancelled')
  })

  it('a bundle whose files all finished is complete, as before', () => {
    const rows = Object.fromEntries(FILES.map((f) => [f, row(f, 'complete')]))
    const [group] = trayBundles(rows, bundleMap, [])
    expect(bundleVerdict(group)).toEqual({ state: 'complete', line: 'Complete (5 files)' })
  })

  it('a cancelled file that was started again is no longer cancelled', () => {
    const rows = { [FILES[0]]: row(FILES[0], 'downloading'), [FILES[3]]: row(FILES[3], 'complete') }
    const [group] = trayBundles(rows, bundleMap, [FILES[0]])
    expect(group.cancelled).toEqual([])
    expect(bundleVerdict(group).state).toBe('running')
  })

  // The box, 03.10.2026, second finding: with every running file cancelled
  // the bundle had no row, so the tray shut itself and read "No active
  // downloads" when opened again. The summary stays until it is cleared.
  it('a bundle with nothing left but cancelled files is still listed, and says so', () => {
    const [group] = trayBundles({}, bundleMap, FILES.slice(0, 3))
    expect(group.name).toBe(LTX)
    expect(group.files).toEqual([])
    expect(group.cancelled).toEqual(FILES.slice(0, 3))
    expect(bundleVerdict(group)).toEqual({ state: 'partial', line: 'Cancelled, 3 files not downloaded' })
  })

  it('a single cancelled file outside any bundle is listed under its own name', () => {
    const [group] = trayBundles({}, {}, ['lora.safetensors'])
    expect(group.name).toBe('lora.safetensors')
    expect(bundleVerdict(group)).toEqual({ state: 'partial', line: 'Cancelled, 1 file not downloaded' })
  })

  it('nothing cancelled and no rows: nothing listed', () => {
    expect(trayBundles({}, bundleMap, [])).toEqual([])
  })

  it('a single file outside any bundle keeps its own row', () => {
    const rows = { 'lora.safetensors': row('lora.safetensors', 'complete') }
    const [group] = trayBundles(rows, {}, [])
    expect(group.name).toBe('lora.safetensors')
    expect(bundleVerdict(group)).toEqual({ state: 'complete', line: 'Complete (1 file)' })
  })
})
