/**
 * The box, 03.10.2026: a bundle of five files, two of them on disk already.
 * The install marks those two as there, and one second later the poll took
 * Rust's list (three running transfers) as the whole picture and wiped them.
 * The tray showed three files, and after "Cancel all" nothing at all. Rows
 * this side wrote itself survive the poll, under whatever Rust reports.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-own-rows-survive-the-poll.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const progress = vi.hoisted(() => ({ rows: {} as Record<string, unknown> }))

vi.mock('../../api/discover', async () => {
  const actual = await vi.importActual<typeof import('../../api/discover')>('../../api/discover')
  return {
    ...actual,
    getDownloadProgress: vi.fn(async () => progress.rows),
    cancelDownload: vi.fn(async () => {}),
    clearDownloadEntry: vi.fn(async () => {}),
  }
})

import { useDownloadStore } from '../downloadStore'
import { trayBundles, bundleVerdict } from '../../lib/download-tray'

const LTX = 'LTX 2.5 · Small (GGUF Q4)'
const THERE = ['audio-vae.safetensors', 'upscaler.safetensors']
const RUNNING = ['transformer.gguf', 'text-encoder.safetensors', 'video-vae.safetensors']
const running = (filename: string) => ({ progress: 10, total: 1000, speed: 5, filename, status: 'downloading' })

beforeEach(() => {
  useDownloadStore.getState().stopPolling()
  useDownloadStore.setState({ downloads: {}, ownRows: {}, cancelled: [], orphans: {}, bundleMap: {} })
  useDownloadStore.getState().setBundleGroup(LTX, [...THERE, ...RUNNING])
  progress.rows = Object.fromEntries(RUNNING.map((f) => [f, running(f)]))
})

const tray = () => {
  const s = useDownloadStore.getState()
  return trayBundles(s.downloads, s.bundleMap, s.cancelled)
}

describe('a file that was already there', () => {
  it('keeps its row through the poll, next to the running transfers', async () => {
    for (const f of THERE) useDownloadStore.getState().markComplete(f)
    await useDownloadStore.getState().refresh()
    const rows = useDownloadStore.getState().downloads
    expect(Object.keys(rows).sort()).toEqual([...THERE, ...RUNNING].sort())
    expect(THERE.map((f) => rows[f].status)).toEqual(['complete', 'complete'])
  })

  it('after "Cancel all" the bundle reads 2 of 5 files downloaded, 3 cancelled', async () => {
    for (const f of THERE) useDownloadStore.getState().markComplete(f)
    await useDownloadStore.getState().refresh()
    for (const f of [...THERE, ...RUNNING]) await useDownloadStore.getState().cancel(f)
    progress.rows = {}
    await useDownloadStore.getState().refresh()
    const [group] = tray()
    expect(group.name).toBe(LTX)
    expect(bundleVerdict(group)).toEqual({ state: 'partial', line: '2 of 5 files downloaded, 3 cancelled' })
  })

  it('goes when the user clears it, and the poll does not bring it back', async () => {
    useDownloadStore.getState().markComplete(THERE[0])
    useDownloadStore.getState().dismiss(THERE[0])
    await useDownloadStore.getState().refresh()
    expect(useDownloadStore.getState().downloads[THERE[0]]).toBeUndefined()
  })

  it('gives way to what Rust reports once the file is started again', async () => {
    useDownloadStore.getState().markInvisible(RUNNING[0])
    expect(useDownloadStore.getState().downloads[RUNNING[0]].status).toBe('error')
    useDownloadStore.getState().setMeta(RUNNING[0], 'https://example.com/t.gguf', 'diffusion_models')
    await useDownloadStore.getState().refresh()
    expect(useDownloadStore.getState().downloads[RUNNING[0]].status).toBe('downloading')
    progress.rows = {}
    await useDownloadStore.getState().refresh()
    expect(useDownloadStore.getState().downloads[RUNNING[0]]).toBeUndefined()
  })
})
