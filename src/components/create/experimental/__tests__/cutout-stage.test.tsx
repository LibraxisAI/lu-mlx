// @vitest-environment jsdom
/**
 * The Cutout stage after the box run of 04.10.2026:
 *  - the setup card named "~300 MB" for a model that is 885 MB,
 *  - after a result there was no way to load another image but leaving the
 *    tool, while Edit's source preview has "Change image" and the list,
 *  - the line under the result repeated the Image tab's seed and model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, mlxMissing: false,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../loadImage', () => ({
  loadImageRef: vi.fn(async (f: File) => ({ filename: `up_${f.name}`, url: `data:image/png;base64,${btoa(f.name)}`, width: 64, height: 64 })),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/backend')>()),
  openExternal: vi.fn(),
}))
vi.mock('../../../../hooks/useCloudCreate', () => ({
  takeCloudRunStop: () => null,
  dataUrlToBlob: (url: string) => new Blob([url], { type: 'image/png' }),
}))

import { Stage } from '../Stage'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { resetInstallRuns } from '../../../../lib/model-install-runs'

const png = (name: string) => new File([name], name, { type: 'image/png' })
const SOURCE = { filename: 'woman-b.png', url: 'data:image/png;base64,AA', width: 512, height: 512 }
let minted = 0

const result = (over: Partial<GalleryItem>): GalleryItem => ({
  id: 'r1', type: 'image', filename: 'locally_uncensored_cfc2ss_00001_.png', subfolder: '', prompt: '', negativePrompt: '',
  model: 'sd_turbo.safetensors', modelType: 'sd15', seed: 697334996, steps: 4, cfgScale: 1, sampler: '', scheduler: '',
  width: 512, height: 512, batchSize: 1, createdAt: Date.now(), dataUrl: 'data:image/png;base64,AA', ...over,
})

function start(backend: 'local' | 'cloud', intent: 'edit' | 'removebg' | 'upscale', rmbg = true) {
  useCreateStore.setState({ backend, caps: { rmbg, 'inpaint-nodes': true } as never })
  useCreateStore.getState().setIntent(intent)
}
const stage = (displayed?: GalleryItem) =>
  render(<Stage displayed={displayed} onOpenMaskEditor={() => {}} onFullscreen={() => {}} />)

beforeEach(() => {
  minted = 0
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:test/${++minted}`),
    revokeObjectURL: vi.fn(),
  }))
  resetInstallRuns()
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, source: null, mask: null, references: [],
    batchSources: [], batchRun: null, gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1,
    imageModelList: [{ name: 'sd_turbo.safetensors', type: 'sd15' }] as never, videoModelList: [],
  })
})
afterEach(() => { cleanup() })

describe('the setup card', () => {
  it('names the size the cutout model really has', () => {
    start('local', 'removebg', false)
    stage()
    const text = document.body.textContent ?? ''
    expect(text).toContain('The 885 MB cutout model downloads automatically on your first cutout.')
    expect(text).not.toContain('300 MB')
  })
})

describe('after a cutout', () => {
  const shown = () => {
    start('local', 'removebg')
    useCreateStore.getState().setSource(SOURCE as never)
    const item = result({ intent: 'removebg', toolModel: 'RMBG-2.0', sourceName: 'woman-b.png' })
    stage(item)
  }

  it('the line under it says size and cutout model, no seed and no image model', () => {
    shown()
    const facts = screen.getByTestId('result-facts').textContent ?? ''
    expect(facts).toBe('512×512·RMBG-2.0')
    expect(facts).not.toMatch(/seed|sd turbo/)
    expect(screen.getByTestId('source-name').textContent).toBe('from woman-b.png')
  })

  it('offers "Change image" and the list, the way the source preview does', () => {
    shown()
    const actions = screen.getByTestId('result-source-actions')
    expect(actions.textContent).toContain('Change image')
    expect(actions.textContent).toContain('Add more images')
    expect(actions.textContent).toContain('Add a folder')
  })

  it('"Change image" puts the new image on the Stage, ready for the next cutout', async () => {
    shown()
    // The result is the newer of the two until the next image arrives.
    await new Promise((r) => setTimeout(r, 5))
    const input = screen.getByTestId('result-source-actions').querySelector('input[type="file"]:not([multiple])') as HTMLInputElement
    fireEvent.change(input, { target: { files: [png('woman-c.png')] } })
    await waitFor(() => expect(useCreateStore.getState().source?.filename).toBe('up_woman-c.png'))
    await waitFor(() => expect(document.body.textContent).toContain('Hit Create to cut out the subject'))
    expect(screen.queryByTestId('result-facts')).toBeNull()
  })

  it('"Add more images" starts a list for one run over all of them', async () => {
    shown()
    const input = screen.getByTestId('batch-files-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [png('woman-c.png'), png('woman-d.png')] } })
    await waitFor(() => expect(useCreateStore.getState().batchSources.length).toBe(3))
    expect(screen.getByTestId('batch-count').textContent).toContain('3 images')
    // With a list the single "Change image" steps aside, as under the source.
    expect(screen.getByTestId('result-source-actions').textContent).not.toContain('Change image')
  })
})

describe('the same way on the other tools that work from an image', () => {
  it('Enhance in the cloud', () => {
    start('cloud', 'upscale')
    useCreateStore.getState().setSource(SOURCE as never)
    stage(result({ intent: 'upscale', jobId: 'j1', width: 2048, height: 2048 }))
    expect(screen.getByTestId('result-source-actions').textContent).toContain('Change image')
    expect(screen.getByTestId('result-source-actions').textContent).toContain('Add more images')
    expect(screen.getByTestId('result-facts').textContent).toBe('2048×2048')
  })

  it('a rendered image keeps size, seed and model, and has no source actions', () => {
    start('local', 'image' as never)
    stage(result({ intent: 'image' }))
    expect(screen.getByTestId('result-facts').textContent).toBe('512×512·seed 697334996·sd turbo')
    expect(screen.queryByTestId('result-source-actions')).toBeNull()
  })
})
