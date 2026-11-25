/**
 * Regression test for macOS + connected ComfyUI LoadImage handling:
 * `stageLocally()` stages input images via `stageStartImage()` to an absolute
 * local disk path for MLX. When a run targets ComfyUI, `LoadImage` rejects an
 * absolute path outside `--input-directory` unless the file is uploaded via
 * `/upload/image` and referenced by its relative ComfyUI input filename.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: true,
  json: async () => ({ name: 'uploaded_frame.png', subfolder: '', type: 'input' }),
}))

import { ensureComfyInputFilename, isLocalStagedPath } from '../../../../api/comfyui'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const PNG_URL = `data:image/png;base64,${PNG_B64}`

describe('ComfyUI input image staging on macOS', () => {
  beforeEach(() => {
    fetchSpy.mockClear()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recognizes host filesystem staged paths vs relative ComfyUI input names', () => {
    expect(isLocalStagedPath('/Users/tester/Library/Application Support/lu-labs/videos/start-images/3611.png')).toBe(true)
    expect(isLocalStagedPath('C:\\Users\\tester\\start.png')).toBe(true)
    expect(isLocalStagedPath('D:/images/start.png')).toBe(true)
    expect(isLocalStagedPath('ComfyUI_input_0001.png')).toBe(false)
    expect(isLocalStagedPath('sub/folder/img.png')).toBe(false)
    expect(isLocalStagedPath('')).toBe(false)
    expect(isLocalStagedPath(undefined)).toBe(false)
  })

  it('uploads a macOS-staged absolute path via ComfyUI /upload/image', async () => {
    const out = await ensureComfyInputFilename({
      filename: '/Users/tester/Library/Application Support/lu-labs/videos/start-images/3611.png',
      url: PNG_URL,
      width: 1,
      height: 1,
      name: 'frame.png',
    }, 'source.png')
    expect(out).toBe('uploaded_frame.png')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/upload/image')
    const form = fetchSpy.mock.calls[0][1]?.body as FormData
    const file = form.get('image') as File
    expect(file.name).toBe('frame.png')
    expect(file.size).toBe(atob(PNG_B64).length)
  })

  it('keeps an existing relative ComfyUI input filename without re-uploading', async () => {
    const out = await ensureComfyInputFilename({
      filename: 'ComfyUI_input_0001.png',
      url: PNG_URL,
      width: 1,
      height: 1,
    }, 'source.png')
    expect(out).toBe('ComfyUI_input_0001.png')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns undefined when ref is null or undefined', async () => {
    expect(await ensureComfyInputFilename(null, 'source.png')).toBeUndefined()
    expect(await ensureComfyInputFilename(undefined, 'source.png')).toBeUndefined()
  })
})
