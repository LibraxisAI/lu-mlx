/**
 * A model and its image part read as ONE download, on every surface.
 *
 * Run: npx vitest run src/lib/__tests__/image-part.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  addImageInputLabel, asOneDownload, canAddImagePart, downloadSizeGB, gbOf, imagePartFileName,
  includeImageInputLabel, isImagePartFile, isUpstreamImagePart, modelFileOfImagePart, pickUpstreamImagePart,
} from '../image-part'
import type { DownloadProgress } from '../../types/downloads'

const GIB = 1_073_741_824
const row = (filename: string, status: DownloadProgress['status'], progress: number, total: number, extra: Partial<DownloadProgress> = {}): DownloadProgress =>
  ({ filename, status, progress, total, speed: 0, ...extra })

describe('the name of an image part on disk', () => {
  it('follows the model, so the engine finds it from the model path alone', () => {
    expect(imagePartFileName('Qwen3.5-9B-abliterated.Q4_K_M.gguf')).toBe('Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf')
    expect(imagePartFileName('A.GGUF')).toBe('A.mmproj.gguf')
    // A split model names its part after its first file.
    expect(imagePartFileName('big-00001-of-00008.gguf')).toBe('big-00001-of-00008.mmproj.gguf')
  })

  it('is told apart from a model, in both directions', () => {
    expect(isImagePartFile('m.Q4_K_M.mmproj.gguf')).toBe(true)
    expect(isImagePartFile('m.Q4_K_M.gguf')).toBe(false)
    expect(modelFileOfImagePart('m.Q4_K_M.mmproj.gguf')).toBe('m.Q4_K_M.gguf')
    expect(modelFileOfImagePart('m.Q4_K_M.gguf')).toBeNull()
  })
})

describe('one progress and one total', () => {
  it('sums the two files and stays running until both are done', () => {
    const one = asOneDownload([
      row('m.gguf', 'downloading', 2 * GIB, 5 * GIB, { speed: 10 }),
      row('m.mmproj.gguf', 'complete', GIB, GIB),
    ])!
    expect(one.status).toBe('downloading')
    expect(one.progress).toBe(3 * GIB)
    expect(one.total).toBe(6 * GIB)
    expect(one.filename).toBe('m.gguf')
  })

  it('is complete only when the image part is too', () => {
    expect(asOneDownload([row('m.gguf', 'complete', 5, 5), row('m.mmproj.gguf', 'downloading', 1, 2)])!.status).toBe('downloading')
    expect(asOneDownload([row('m.gguf', 'complete', 5, 5), row('m.mmproj.gguf', 'complete', 2, 2)])!.status).toBe('complete')
  })

  it('carries the error of whichever file failed', () => {
    const one = asOneDownload([row('m.gguf', 'downloading', 1, 5), row('m.mmproj.gguf', 'error', 0, 2, { error: 'The file does not match its checksum.' })])!
    expect(one.status).toBe('error')
    expect(one.error).toBe('The file does not match its checksum.')
  })

  it('reads paused when nothing runs and something waits', () => {
    expect(asOneDownload([row('m.gguf', 'paused', 1, 5), row('m.mmproj.gguf', 'complete', 2, 2)])!.status).toBe('paused')
  })

  it('is the model alone when the part was left out, and nothing when nothing started', () => {
    const alone = row('m.gguf', 'downloading', 1, 5)
    expect(asOneDownload([alone, undefined])).toBe(alone)
    expect(asOneDownload([undefined, undefined])).toBeNull()
  })
})

describe('the sizes and the words', () => {
  it('adds the part to the model, to one decimal', () => {
    expect(downloadSizeGB(5, 918166080, true)).toBe(5.9)
    expect(downloadSizeGB(5, 918166080, false)).toBe(5)
    expect(downloadSizeGB(16.5, undefined, true)).toBe(16.5)
    expect(downloadSizeGB(undefined, 918166080, true)).toBeUndefined()
    expect(gbOf(918166080)).toBe(0.9)
  })

  it('labels the tick box and the one click in English, with the size', () => {
    expect(includeImageInputLabel(918166080)).toBe('Include image input (+0.9 GB)')
    expect(includeImageInputLabel(undefined)).toBe('Include image input')
    expect(addImageInputLabel(918166080)).toBe('Add image input (0.9 GB)')
  })
})

describe('the part a repository ships', () => {
  const files = [
    { path: 'model-Q4_K_M.gguf', size: 5 },
    { path: 'mmproj-F32.gguf', size: 4 },
    { path: 'mmproj-BF16.gguf', size: 2 },
    { path: 'mmproj-F16.gguf', size: 2 },
  ]

  it('is recognised by name, and a model is not', () => {
    expect(isUpstreamImagePart('mmproj-F16.gguf')).toBe(true)
    expect(isUpstreamImagePart('sub/Holo-3.1-9B.mmproj-Q8_0.gguf')).toBe(true)
    expect(isUpstreamImagePart('model-Q4_K_M.gguf')).toBe(false)
    expect(isUpstreamImagePart('mmproj-notes.txt')).toBe(false)
  })

  it('is taken as F16 first, BF16 second, and F32 last', () => {
    expect(pickUpstreamImagePart(files)!.path).toBe('mmproj-F16.gguf')
    expect(pickUpstreamImagePart(files.filter((f) => f.path !== 'mmproj-F16.gguf'))!.path).toBe('mmproj-BF16.gguf')
    expect(pickUpstreamImagePart([files[0], files[1]])!.path).toBe('mmproj-F32.gguf')
    expect(pickUpstreamImagePart([files[0]])).toBeNull()
  })
})

describe('the offer to add a missing part', () => {
  it('is made exactly when the part is missing and a source is known', () => {
    const source = { url: 'https://huggingface.co/a/b/resolve/main/mmproj-F16.gguf' }
    expect(canAddImagePart({ present: false, source })).toBe(true)
    expect(canAddImagePart({ present: true, source })).toBe(false)
    expect(canAddImagePart({ present: false, source: null })).toBe(false)
    expect(canAddImagePart(null)).toBe(false)
  })
})
