// @vitest-environment jsdom
/**
 * A saved character clicked in Edit (box run, 03.10.2026): the click replaced
 * the picture the user was editing with the character's first photo. With a
 * source loaded the photos are reference photos, all of them; only an empty
 * slot takes the first photo as the source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../loadImage', () => ({
  loadImageRef: vi.fn(async (file: File) => ({ filename: file.name, url: `blob:${file.name}`, width: 8, height: 8 })),
}))

import { loadPhotosAsReferences } from '../characterPhotos'
import { useCreateStore, type ImageRef } from '../../../../stores/createStore'
import { MAX_STORED_REFERENCES } from '../../../../lib/edit-references'

const photo = () => new Blob(['x'], { type: 'image/jpeg' })
const ref = (filename: string): ImageRef => ({ filename, url: `blob:${filename}`, width: 8, height: 8 })
const names = (list: readonly ImageRef[]) => list.map((r) => r.filename)

beforeEach(() => {
  useCreateStore.setState({
    backend: 'local', cloudOp: null, utilityOp: null, removebg: false,
    source: null, mask: null, references: [], batchSources: [],
  } as never)
  useCreateStore.getState().setIntent('edit')
})

describe('a saved character clicked in Edit', () => {
  it('a source is loaded: it stays, and every photo joins the reference photos', async () => {
    const mask = ref('mask.png')
    useCreateStore.setState({ source: ref('street.png'), mask, references: [ref('hat.png')] } as never)
    const loaded = await loadPhotosAsReferences('probe', [photo(), photo(), photo()])
    const s = useCreateStore.getState()
    expect(s.source?.filename).toBe('street.png')
    expect(s.mask).toBe(mask)
    expect(names(s.references)).toEqual(['hat.png', 'probe-01.jpg', 'probe-02.jpg', 'probe-03.jpg'])
    expect(loaded).toBe(3)
  })

  it('a full strip takes only what fits and says how many it took', async () => {
    const full = Array.from({ length: MAX_STORED_REFERENCES - 1 }, (_, i) => ref(`r${i}.png`))
    useCreateStore.setState({ source: ref('street.png'), references: full } as never)
    const loaded = await loadPhotosAsReferences('probe', [photo(), photo(), photo()])
    const s = useCreateStore.getState()
    expect(s.references).toHaveLength(MAX_STORED_REFERENCES)
    expect(names(s.references).at(-1)).toBe('probe-01.jpg')
    expect(loaded).toBe(1)
  })

  it('no source: the first photo becomes the source, the rest are reference photos', async () => {
    await loadPhotosAsReferences('probe', [photo(), photo(), photo()])
    const s = useCreateStore.getState()
    expect(s.source?.filename).toBe('probe-01.jpg')
    expect(names(s.references)).toEqual(['probe-02.jpg', 'probe-03.jpg'])
  })

  it('from another tab: Create switches to Edit and the photos replace what was loaded there', async () => {
    useCreateStore.setState({ source: ref('old.png'), references: [ref('hat.png')] } as never)
    useCreateStore.getState().setIntent('image')
    await loadPhotosAsReferences('probe', [photo(), photo()])
    const s = useCreateStore.getState()
    expect(s.intent()).toBe('edit')
    expect(s.source?.filename).toBe('probe-01.jpg')
    expect(names(s.references)).toEqual(['probe-02.jpg'])
  })
})
