/**
 * A model and its image part are one download, so a cancel of the model takes
 * the part along: a running part is cancelled, a finished one is removed from
 * disk. Cancelling only the part leaves the model.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-image-part-goes-with-its-model.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cancelDownload = vi.fn(async (_id: string) => {})
const removeImagePart = vi.fn(async (_dir: string, _file: string) => {})
const clearDownloadEntry = vi.fn(async (_id: string) => {})

vi.mock('../../api/discover', async () => {
  const actual = await vi.importActual<typeof import('../../api/discover')>('../../api/discover')
  return {
    ...actual,
    getDownloadProgress: vi.fn(async () => ({})),
    cancelDownload: (id: string) => cancelDownload(id),
    removeImagePart: (dir: string, file: string) => removeImagePart(dir, file),
    clearDownloadEntry: (id: string) => clearDownloadEntry(id),
  }
})

import { useDownloadStore } from '../downloadStore'

const MODEL = 'Qwen3.5-9B-abliterated.Q4_K_M.gguf'
const PART = 'Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf'
const DIR = '/models'
const row = (filename: string, status: string) => ({ progress: 1, total: 2, speed: 0, filename, status })

function seed(partStatus: string) {
  useDownloadStore.setState({
    downloads: { [MODEL]: row(MODEL, 'downloading'), [PART]: row(PART, partStatus) },
    downloadMeta: {
      [MODEL]: { url: 'https://huggingface.co/a/b/resolve/main/m.gguf', subfolder: 'gguf', destDir: DIR },
      [PART]: { url: 'https://huggingface.co/a/b/resolve/main/mmproj-F16.gguf', subfolder: 'gguf', destDir: DIR },
    },
    ownRows: {},
    orphans: {},
    cancelled: [],
    bundleMap: { [MODEL]: 'Qwen 3.5 9B Abliterated', [PART]: 'Qwen 3.5 9B Abliterated' },
  } as never)
}

beforeEach(() => {
  cancelDownload.mockClear()
  removeImagePart.mockClear()
  clearDownloadEntry.mockClear()
})

describe('cancelling a model with an image part', () => {
  it('cancels the part that is still running', async () => {
    seed('downloading')
    await useDownloadStore.getState().cancel(MODEL)
    expect(cancelDownload.mock.calls.map((c) => c[0])).toEqual([MODEL, PART])
    expect(removeImagePart).not.toHaveBeenCalled()
    const s = useDownloadStore.getState()
    expect(s.downloads[MODEL]).toBeUndefined()
    expect(s.downloads[PART]).toBeUndefined()
    expect(s.cancelled).toEqual([MODEL, PART])
  })

  it('removes the part that already finished, from the folder it was written to', async () => {
    seed('complete')
    await useDownloadStore.getState().cancel(MODEL)
    expect(cancelDownload.mock.calls.map((c) => c[0])).toEqual([MODEL])
    expect(removeImagePart).toHaveBeenCalledWith(DIR, PART)
    // The finished row is cleared on the backend too, or the next poll brings it back.
    expect(clearDownloadEntry).toHaveBeenCalledWith(PART)
    expect(useDownloadStore.getState().downloads[PART]).toBeUndefined()
  })

  it('leaves the model alone when only the part is cancelled', async () => {
    seed('downloading')
    await useDownloadStore.getState().cancel(PART)
    expect(cancelDownload.mock.calls.map((c) => c[0])).toEqual([PART])
    expect(useDownloadStore.getState().downloads[MODEL]?.status).toBe('downloading')
    expect(useDownloadStore.getState().cancelled).toEqual([PART])
  })

  it('touches no other file when the model has no part', async () => {
    useDownloadStore.setState({
      downloads: { 'text.gguf': row('text.gguf', 'downloading'), 'other.mmproj.gguf': row('other.mmproj.gguf', 'complete') },
      downloadMeta: {}, ownRows: {}, orphans: {}, cancelled: [], bundleMap: {},
    } as never)
    await useDownloadStore.getState().cancel('text.gguf')
    expect(cancelDownload.mock.calls.map((c) => c[0])).toEqual(['text.gguf'])
    expect(removeImagePart).not.toHaveBeenCalled()
    expect(useDownloadStore.getState().downloads['other.mmproj.gguf']?.status).toBe('complete')
  })
})

describe('"Cancel all" on the one row of model and part', () => {
  it('cancels each file once, whichever comes first', async () => {
    for (const order of [[MODEL, PART], [PART, MODEL]]) {
      cancelDownload.mockClear()
      seed('downloading')
      // The download list calls cancel for every file of the row at once.
      await Promise.all(order.map((f) => useDownloadStore.getState().cancel(f)))
      expect(cancelDownload.mock.calls.map((c) => c[0]).sort()).toEqual([MODEL, PART].sort())
      expect(useDownloadStore.getState().downloads).toEqual({})
    }
  })
})
