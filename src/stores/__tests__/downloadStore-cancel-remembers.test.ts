/**
 * The other half of the cancelled bundle (lib/download-tray): the store
 * remembers which files the user cancelled, until they are started again or
 * the user clears the row. A finished file is never "cancelled": cancelling it
 * only made its row flicker out and back with the next poll.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-cancel-remembers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cancelDownload = vi.fn(async () => {})

vi.mock('../../api/discover', async () => {
  const actual = await vi.importActual<typeof import('../../api/discover')>('../../api/discover')
  return {
    ...actual,
    getDownloadProgress: vi.fn(async () => ({})),
    cancelDownload: (...a: unknown[]) => cancelDownload(...(a as [])),
    clearDownloadEntry: vi.fn(async () => {}),
  }
})

import { useDownloadStore } from '../downloadStore'

const row = (filename: string, status: string) => ({ progress: 1, total: 2, speed: 0, filename, status })

beforeEach(() => {
  cancelDownload.mockClear()
  useDownloadStore.setState({
    downloads: {
      'model.gguf': row('model.gguf', 'downloading'),
      'vae.safetensors': row('vae.safetensors', 'complete'),
    },
    cancelled: [],
    bundleMap: { 'model.gguf': 'Bundle', 'vae.safetensors': 'Bundle' },
  } as never)
})

describe('cancel', () => {
  it('remembers the file it stopped', async () => {
    await useDownloadStore.getState().cancel('model.gguf')
    expect(cancelDownload).toHaveBeenCalledWith('model.gguf')
    expect(useDownloadStore.getState().downloads['model.gguf']).toBeUndefined()
    expect(useDownloadStore.getState().cancelled).toEqual(['model.gguf'])
  })

  it('leaves a finished file alone', async () => {
    await useDownloadStore.getState().cancel('vae.safetensors')
    expect(cancelDownload).not.toHaveBeenCalled()
    expect(useDownloadStore.getState().downloads['vae.safetensors']?.status).toBe('complete')
    expect(useDownloadStore.getState().cancelled).toEqual([])
  })

  it('starting the file again forgets the cancel', async () => {
    await useDownloadStore.getState().cancel('model.gguf')
    useDownloadStore.getState().setMeta('model.gguf', 'https://example.com/model.gguf', 'diffusion_models')
    expect(useDownloadStore.getState().cancelled).toEqual([])
  })

  it('clearing the bundle row forgets its cancelled files', async () => {
    await useDownloadStore.getState().cancel('model.gguf')
    useDownloadStore.getState().forgetCancelled(['model.gguf'])
    expect(useDownloadStore.getState().cancelled).toEqual([])
  })
})
