/**
 * The box, 04.10.2026: the Cutout card said "~300 MB", the node fetched
 * 884 878 856 bytes, and it did so inside the first run while the Stage said
 * "Queued...". One module now holds the model, its measured size and the
 * question whether it is on the drive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.hoisted(() => vi.fn())
const target = vi.hoisted(() => ({ remote: false }))
vi.mock('../backend', () => ({ backendCall }))
vi.mock('../discover', () => ({ comfyModelTarget: async () => target }))

import { cutoutDownloadLine, cutoutModelOf, DEFAULT_CUTOUT_MODEL, DEFAULT_CUTOUT_MODEL_SIZE } from '../cutout-model'

const LINE = 'Downloading the cutout model (885 MB), first run only...'
const graph = (model?: unknown) => ({
  '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
  '2': { class_type: 'RMBG', inputs: { image: ['1', 0], ...(model === undefined ? {} : { model }) } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
})

beforeEach(() => {
  backendCall.mockReset()
  target.remote = false
})

describe('the size the card names', () => {
  it('is the measured one', () => {
    expect(DEFAULT_CUTOUT_MODEL).toBe('RMBG-2.0')
    expect(DEFAULT_CUTOUT_MODEL_SIZE).toBe('885 MB')
  })
})

describe('cutoutModelOf', () => {
  it('reads the model off the RMBG node', () => {
    expect(cutoutModelOf(graph('RMBG-2.0') as never)).toBe('RMBG-2.0')
    expect(cutoutModelOf(graph('BEN2') as never)).toBe('BEN2')
  })
  it('is undefined without the node or without a model widget', () => {
    expect(cutoutModelOf(graph() as never)).toBeUndefined()
    expect(cutoutModelOf({ '1': { class_type: 'KSampler', inputs: { model: ['4', 0] } } } as never)).toBeUndefined()
  })
})

describe('cutoutDownloadLine', () => {
  it('says the download when the model file is not on the drive', async () => {
    backendCall.mockResolvedValue([{ filename: 'RMBG-2.0/model.safetensors', exists: false, complete: false }])
    expect(await cutoutDownloadLine('RMBG-2.0')).toBe(LINE)
    expect(backendCall).toHaveBeenCalledWith('check_model_sizes', {
      files: [{ subfolder: 'RMBG', filename: 'RMBG-2.0/model.safetensors', expectedBytes: 884_878_856 }],
    })
  })
  it('says it for a file that broke off early too', async () => {
    backendCall.mockResolvedValue([{ exists: true, complete: false }])
    expect(await cutoutDownloadLine('RMBG-2.0')).toBe(LINE)
  })
  it('says nothing when the file is there', async () => {
    backendCall.mockResolvedValue([{ exists: true, complete: true }])
    expect(await cutoutDownloadLine('RMBG-2.0')).toBeNull()
  })
  it('says nothing about a model it has no measured size for, and does not ask', async () => {
    expect(await cutoutDownloadLine('BEN2')).toBeNull()
    expect(await cutoutDownloadLine(undefined)).toBeNull()
    expect(backendCall).not.toHaveBeenCalled()
  })
  it('says nothing for a ComfyUI on another machine, whose drive it cannot see', async () => {
    target.remote = true
    expect(await cutoutDownloadLine('RMBG-2.0')).toBeNull()
    expect(backendCall).not.toHaveBeenCalled()
  })
  it('says nothing when the backend does not answer', async () => {
    backendCall.mockRejectedValue(new Error('no such command'))
    expect(await cutoutDownloadLine('RMBG-2.0')).toBeNull()
  })
  it('carries no dash', () => {
    expect(LINE).not.toMatch(/[\u2013\u2014]/)
  })
})
