/** @vitest-environment jsdom */
/**
 * Adding the image part to a model that is already installed: where the part
 * comes from, where it lands, and what happens when it has arrived.
 *
 * Run: npx vitest run src/api/__tests__/image-part-install.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const startModelDownloadToPath = vi.fn(async (..._a: unknown[]) => ({ status: 'started' }))
const resolveHfGgufFiles = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)
const bundledEngineStatus = vi.fn(async (): Promise<unknown> => ({ running: false }))
const swapBundledModel = vi.fn(async (_p: string) => true)

vi.mock('../discover', async () => {
  const actual = await vi.importActual<typeof import('../discover')>('../discover')
  return {
    ...actual,
    startModelDownloadToPath: (...a: unknown[]) => startModelDownloadToPath(...a),
    resolveHfGgufFiles: (...a: unknown[]) => resolveHfGgufFiles(...a),
    getDownloadProgress: vi.fn(async () => ({})),
  }
})
vi.mock('../engine', () => ({
  bundledEngineStatus: () => bundledEngineStatus(),
  swapBundledModel: (p: string) => swapBundledModel(p),
}))
vi.mock('../../lib/run-idle', () => ({ whenRunsIdle: (fn: () => void) => fn() }))

import { addImagePart, catalogImagePartFor, fileNameOf, findImagePartSource, folderOf, __resetImagePartSources } from '../image-part-install'
import { useDownloadStore } from '../../stores/downloadStore'

const MODEL = 'Qwen3.5-9B-abliterated.Q4_K_M.gguf'
const PART = 'Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf'

beforeEach(() => {
  startModelDownloadToPath.mockClear()
  resolveHfGgufFiles.mockReset()
  resolveHfGgufFiles.mockResolvedValue(null)
  bundledEngineStatus.mockReset()
  bundledEngineStatus.mockResolvedValue({ running: false })
  swapBundledModel.mockClear()
  __resetImagePartSources()
  useDownloadStore.getState().stopPolling?.()
  useDownloadStore.setState({ downloads: {}, downloadMeta: {}, bundleMap: {} } as never)
})

describe('paths', () => {
  it('reads name and folder on both kinds of separator', () => {
    expect(fileNameOf('C:\\Users\\a\\models\\m.gguf')).toBe('m.gguf')
    expect(folderOf('C:\\Users\\a\\models\\m.gguf')).toBe('C:\\Users\\a\\models')
    expect(fileNameOf('/home/a/models/m.gguf')).toBe('m.gguf')
    expect(folderOf('/home/a/models/m.gguf')).toBe('/home/a/models')
  })
})

describe('where the part of an installed model comes from', () => {
  it('the catalog answers for the model of the test machine, with size and digest', () => {
    const part = catalogImagePartFor(MODEL)
    expect(part?.url).toBe('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf')
    expect(part?.sizeBytes).toBe(918166080)
    expect(part?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the file name without regard to case', () => {
    expect(catalogImagePartFor(MODEL.toLowerCase())).not.toBeNull()
  })

  it('a text model of the catalog has none, and neither has an unknown file', async () => {
    expect(catalogImagePartFor('glm-4-9b-chat-abliterated-Q4_K_M.gguf')).toBeNull()
    expect(await findImagePartSource('something-of-my-own.Q4_K_M.gguf')).toBeNull()
    expect(resolveHfGgufFiles).not.toHaveBeenCalled()
  })

  it("asks the repository a user's own model was downloaded from, once", async () => {
    useDownloadStore.setState({
      downloadMeta: { 'mine.Q5_K_M.gguf': { url: 'https://huggingface.co/someone/mine-GGUF/resolve/main/mine.Q5_K_M.gguf', subfolder: 'gguf' } },
    } as never)
    resolveHfGgufFiles.mockResolvedValue({ imagePart: { url: 'https://huggingface.co/someone/mine-GGUF/resolve/main/mmproj-F16.gguf', sizeBytes: 100 } })
    const first = await findImagePartSource('mine.Q5_K_M.gguf')
    const second = await findImagePartSource('mine.Q5_K_M.gguf')
    expect(first).toEqual({ url: 'https://huggingface.co/someone/mine-GGUF/resolve/main/mmproj-F16.gguf', sizeBytes: 100 })
    expect(second).toEqual(first)
    expect(resolveHfGgufFiles).toHaveBeenCalledTimes(1)
    expect(resolveHfGgufFiles.mock.calls[0][0]).toBe('someone/mine-GGUF')
  })
})

describe('the one click', () => {
  it('downloads the part next to the model, under the name the engine looks for, with its digest', async () => {
    await addImagePart(`C:\\models\\${MODEL}`, 'Qwen 3.5 9B Abliterated image input')
    expect(startModelDownloadToPath).toHaveBeenCalledTimes(1)
    const [url, dir, filename, bytes, sha] = startModelDownloadToPath.mock.calls[0]
    expect(url).toBe('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf')
    expect(dir).toBe('C:\\models')
    expect(filename).toBe(PART)
    expect(bytes).toBe(918166080)
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('says so when no part is known, and starts nothing', async () => {
    await expect(addImagePart('/models/something-of-my-own.gguf')).rejects.toThrow('No image part is known for this model.')
    expect(startModelDownloadToPath).not.toHaveBeenCalled()
  })

  it('refreshes the lists when the part has arrived, and leaves an engine alone that runs another model', async () => {
    const refreshed = vi.fn()
    window.addEventListener('lu-models-refresh', refreshed)
    bundledEngineStatus.mockResolvedValue({ running: true, model_path: '/models/other.gguf' })
    await addImagePart(`/models/${MODEL}`)
    useDownloadStore.getState().markComplete(PART)
    await vi.waitFor(() => expect(bundledEngineStatus).toHaveBeenCalled())
    expect(refreshed).toHaveBeenCalled()
    expect(swapBundledModel).not.toHaveBeenCalled()
    window.removeEventListener('lu-models-refresh', refreshed)
  })

  it('loads the model again when it is the one that runs, so that it can see', async () => {
    bundledEngineStatus.mockResolvedValue({ running: true, model_path: `C:/models/${MODEL}` })
    await addImagePart(`C:\\models\\${MODEL}`)
    useDownloadStore.getState().markComplete(PART)
    await vi.waitFor(() => expect(swapBundledModel).toHaveBeenCalledWith(`C:\\models\\${MODEL}`))
  })

  it('a failed download loads nothing', async () => {
    bundledEngineStatus.mockResolvedValue({ running: true, model_path: `/models/${MODEL}` })
    await addImagePart(`/models/${MODEL}`)
    useDownloadStore.setState((s) => ({ downloads: { ...s.downloads, [PART]: { filename: PART, progress: 0, total: 1, speed: 0, status: 'error', error: 'x' } } }) as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(swapBundledModel).not.toHaveBeenCalled()
  })
})
