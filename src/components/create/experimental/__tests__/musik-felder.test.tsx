// @vitest-environment jsdom
/**
 * Fund M2 und M1 (05.10.2026, Vorlagen: zwei Tests der Web-App).
 *
 * M2: der Laengen-Regler in Musik stand bei jedem Modell da, wirkte bei den
 * vier Studio-Musikmodellen aber nicht. Er steht nur, wo das Modell eine Laenge
 * liest, und setzt genau das Feld, das der Lauf schickt und aus dem der Preis
 * rechnet.
 *
 * M1: bei Mureka Song ist das grosse Textfeld laut Schema der
 * Liedtext. Die Oberflaeche sagte "Describe the track" und behauptete, das
 * Modell schreibe den Text selbst. Beschriftung, Hinweis und das zweite
 * Textfeld kommen aus dem Schema des gewaehlten Modells.
 *
 * Lokal bleibt alles, wie es war: Regler von 5 Sekunden bis 4 Minuten, der
 * Prompt ist der Stil, der Liedtext-Kasten steht immer da.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: false,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../../api/backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openExternal: vi.fn(),
}))

import { SpecialControls } from '../SpecialIntentControls'
import { Composer } from '../Composer'
import { Stage } from '../Stage'
import { StudioParams } from '../StudioParams'
import { ImproveToggle } from '../ImproveToggle'
import { useCreateStore } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { MUSIC_PLACEHOLDER, improveKindForRun, musicLength, musicText } from '../../../../lib/render/music-ui'
import { intentPickerModels } from '../../../../lib/render/create-studio'
import { STUDIO_MODELS, studioFields, studioOptions, studioPreviewCredits, studioSchema } from '../../../../lib/render/studio-contract'
import { INTENT_MAP } from '../intents'

const range = (c: HTMLElement) => c.querySelector('input[type=range]') as HTMLInputElement | null

function pick(model: string) {
  const s = useCreateStore.getState()
  s.setIntent('music'); s.setCloudOpModel(model)
}
function musik(model: string) {
  pick(model)
  return render(<SpecialControls intent="music" />)
}
function composer(model: string) {
  pick(model)
  return render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
}

beforeEach(() => {
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.setState({
    backend: 'cloud', isGenerating: false, error: null, cloudStudioOptions: {}, cloudOpModel: '', cloudOpPicks: {},
    musicDuration: 30, musicLyrics: '', improvePrompt: false, gallery: [], audioModelList: [],
  })
  useCreateStore.getState().setPrompt('')
})
afterEach(cleanup)

describe('Laengen-Regler in Musik', () => {
  it('ElevenLabs Music: der Regler setzt das Millisekunden-Feld in dessen Grenzen', () => {
    const { container } = musik('eleven-music')
    const r = range(container)!
    expect(screen.getByText('Length')).toBeTruthy()
    expect([r.min, r.max]).toEqual(['5', '600'])
    // Ohne Zutun steht dort, was der Lauf schickt: 30 Sekunden.
    expect(r.value).toBe('30')
    expect(screen.getByText('0:30')).toBeTruthy()
    fireEvent.change(r, { target: { value: '180' } })
    const options = useCreateStore.getState().cloudStudioOptions
    expect(options).toEqual({ music_length_ms: 180000 })
    expect(useCreateStore.getState().musicDuration).toBe(30)
    // Anfrage und Preis lesen dasselbe Feld: drei angefangene Minuten.
    expect(studioOptions('eleven-music', 'x', options).music_length_ms).toBe(180000)
    expect(studioPreviewCredits('eleven-music', options)).toBe(3 * studioPreviewCredits('eleven-music', {})!)
  })

  it('MiniMax Music und Mureka Song kennen keine Laenge und zeigen keinen Regler', () => {
    for (const model of ['minimax-music', 'mureka-song']) {
      const { container, unmount } = musik(model)
      expect(screen.queryByText('Length'), model).toBeNull()
      expect(range(container), model).toBeNull()
      unmount()
    }
  })

  it('ein klassisches Modell behaelt seinen Regler in Sekunden', () => {
    const { container } = musik('ace-step-1.5')
    const r = range(container)!
    expect([r.min, r.max]).toEqual(['5', '240'])
    fireEvent.change(r, { target: { value: '120' } })
    expect(useCreateStore.getState().musicDuration).toBe(120)
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
  })

  it('jedes Musikmodell im Waehler: Regler genau dann, wenn sein Schema eine Laenge traegt', () => {
    const models = intentPickerModels('music')
    expect(models.some((m) => STUDIO_MODELS[m.id])).toBe(true)
    for (const m of models) {
      const studio = STUDIO_MODELS[m.id]
      const length = musicLength(m.id)
      if (!studio) { expect(length?.option, m.id).toBeUndefined(); expect(length, m.id).not.toBeNull(); continue }
      const field = Object.keys(studioFields(m.id)).find((k) => /length|duration/.test(k))
      expect(length?.option, m.id).toBe(field)
    }
  })

  it('lokal bleibt der Regler von 5 Sekunden bis 4 Minuten, auch wenn die Cloud-Wahl keine Laenge kennt', () => {
    pick('mureka-song')
    useCreateStore.setState({ backend: 'local', cloudStudioOptions: {} })
    const { container } = render(<SpecialControls intent="music" />)
    const r = range(container)!
    expect([r.min, r.max]).toEqual(['5', '240'])
    fireEvent.change(r, { target: { value: '90' } })
    expect(useCreateStore.getState().musicDuration).toBe(90)
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
  })
})

describe('welcher Text wohin gehoert, je Modell aus dem Schema', () => {
  it('jedes Musikmodell: Hauptfeld und zweites Feld stimmen mit seinem Schema', () => {
    for (const m of intentPickerModels('music')) {
      const text = musicText(m.id)
      const studio = STUDIO_MODELS[m.id]
      if (!studio) { expect(text.main, m.id).toBe('style'); continue }
      expect(text.main, m.id).toBe((studio.promptField ?? 'prompt') === 'lyrics' ? 'lyrics' : 'style')
      if (text.second) {
        expect(text.second.option, m.id).not.toBe(studio.promptField ?? 'prompt')
        expect(studioSchema(m.id).properties?.[text.second.option!]?.type, m.id).toBe('string')
      }
    }
    expect(musicText('mureka-song')).toEqual({ main: 'lyrics', second: { is: 'style', option: 'prompt' } })
    expect(musicText('minimax-music')).toEqual({ main: 'style', second: { is: 'lyrics', option: 'lyrics' } })
    expect(musicText('eleven-music')).toEqual({ main: 'style', second: null })
    expect(musicText('ace-step-1.5')).toEqual({ main: 'style', second: { is: 'lyrics' } })
    expect(musicText('ace-step')).toEqual({ main: 'style', second: null })
  })

  it('Mureka Song: das Feld fragt nach dem Liedtext, nicht nach einer Beschreibung', () => {
    composer('mureka-song')
    expect(screen.getByPlaceholderText(MUSIC_PLACEHOLDER.lyrics)).toBeTruthy()
    expect(screen.queryByPlaceholderText(MUSIC_PLACEHOLDER.style)).toBeNull()
    expect(screen.queryByText(/writes its own lyrics/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Style' })).toBeTruthy()
  })

  it('ein Modell, das den Stil liest, fragt weiter nach der Beschreibung', () => {
    composer('eleven-music')
    expect(INTENT_MAP.music.placeholder).toBe(MUSIC_PLACEHOLDER.style)
    expect(screen.getByPlaceholderText(MUSIC_PLACEHOLDER.style)).toBeTruthy()
    expect(screen.getByText('This model writes its own lyrics from the prompt.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Lyrics' })).toBeNull()
  })

  it('Mureka Song: der Stil geht in das Feld, das der Anbieter "prompt" nennt', () => {
    musik('mureka-song')
    fireEvent.click(screen.getByRole('button', { name: 'Style' }))
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'dreamy lofi' } })
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({ prompt: 'dreamy lofi' })
  })

  it('Mureka Song: auch die Klappe nennt das Feld Style und nicht Prompt', () => {
    render(<StudioParams model="mureka-song" />)
    expect(screen.getByLabelText('Style')).toBeTruthy()
    expect(screen.queryByLabelText('Prompt')).toBeNull()
  })

  it('MiniMax Music: der eigene Liedtext geht in die Option lyrics, nicht in den klassischen Kasten', () => {
    musik('minimax-music')
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }))
    fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value: '[Verse]\nla la' } })
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({ lyrics: '[Verse]\nla la' })
    expect(useCreateStore.getState().musicLyrics).toBe('')
  })

  it('ACE-Step 1.5 behaelt seinen Liedtext-Kasten', () => {
    musik('ace-step-1.5')
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }))
    fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value: 'la la' } })
    expect(useCreateStore.getState().musicLyrics).toBe('la la')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
  })

  it('lokal: der Prompt bleibt der Stil und der Liedtext-Kasten steht immer da, was auch immer die Cloud-Wahl ist', () => {
    pick('mureka-song')
    useCreateStore.setState({ backend: 'local', cloudStudioOptions: {} })
    render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
    expect(screen.getByPlaceholderText(MUSIC_PLACEHOLDER.style)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Style' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }))
    fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value: 'la la' } })
    expect(useCreateStore.getState().musicLyrics).toBe('la la')
    expect(useCreateStore.getState().cloudStudioOptions).toEqual({})
  })
})

describe('Improve my prompt', () => {
  it('ein Liedtext-Feld bekommt keine Umschreibung, ein Stil-Feld schon', () => {
    expect(improveKindForRun('music', 'mureka-song')).toBeNull()
    expect(improveKindForRun('music', 'eleven-music')).toBe('music')
    expect(improveKindForRun('music', 'ace-step-1.5')).toBe('music')
    expect(improveKindForRun('image', 'mureka-song')).toBe('image')
    expect(improveKindForRun('lipsync', 'x')).toBeNull()
  })

  it('der Schalter steht in der Cloud bei einem Liedtext-Modell nicht in der Klappe, lokal immer', () => {
    pick('mureka-song')
    const a = render(<ImproveToggle />)
    expect(screen.queryByText('Improve my prompt')).toBeNull()
    a.unmount()
    pick('eleven-music')
    const b = render(<ImproveToggle />)
    expect(screen.getByText('Improve my prompt')).toBeTruthy()
    b.unmount()
    pick('mureka-song')
    useCreateStore.setState({ backend: 'local' })
    render(<ImproveToggle />)
    expect(screen.getByText('Improve my prompt')).toBeTruthy()
  })

  it('die Stil-Beispiele stehen in der Cloud nicht da, wo sie gesungen wuerden', () => {
    const BEISPIEL = INTENT_MAP.music.examples[0]
    const stage = () => render(<Stage onOpenMaskEditor={() => {}} onFullscreen={() => {}} />)
    pick('eleven-music')
    const a = stage()
    expect(screen.getByText(BEISPIEL)).toBeTruthy()
    a.unmount()
    pick('mureka-song')
    const b = stage()
    expect(screen.queryByText(BEISPIEL)).toBeNull()
    b.unmount()
    useCreateStore.setState({ backend: 'local', audioModelList: [{ name: 'yue2_3b_int8_convrot.safetensors', type: 'ace' }] } as never)
    stage()
    expect(screen.getByText(BEISPIEL)).toBeTruthy()
  })
})
