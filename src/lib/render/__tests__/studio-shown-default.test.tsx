// @vitest-environment jsdom
/**
 * Fund M6 (05.10.2026, Vorlage: the web app):
 * die Klappe zeigte den Standard des Anbieters,
 * geschickt und gebucht wurde der Standard des Modells (Seedance 2.5 Avatar:
 * 720p angezeigt, 480p gelaufen). Ein Regler zeigt, was der Lauf ohne Zutun
 * schickt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))

import { STUDIO_MODELS, studioFields, studioOptions, studioPreviewCredits } from '../studio-contract'
import { studioShownValue } from '../create-studio'
import { StudioParams } from '../../../components/create/experimental/StudioParams'
import { useCreateStore } from '../../../stores/createStore'

describe('der angezeigte Standard eines Studio-Felds', () => {
  it('ist bei jedem Modell und jedem Feld der Wert, den der Server ohne Angabe schickt', () => {
    let abweichend = 0
    for (const id of Object.keys(STUDIO_MODELS)) {
      const sent = studioOptions(id, 'x', {}, false)
      for (const [key, schema] of Object.entries(studioFields(id))) {
        expect(studioShownValue(id, {}, key), `${id} ${key}`).toEqual(sent[key])
        if (STUDIO_MODELS[id].defaults[key] !== undefined && STUDIO_MODELS[id].defaults[key] !== schema.default) abweichend++
      }
    }
    // Positivkontrolle: es gibt Felder, bei denen Modell und Anbieter verschieden vorgeben.
    expect(abweichend).toBeGreaterThan(0)
  })

  it('Seedance 2.5 Avatar: 480p, nicht die 720p des Anbieters', () => {
    expect(studioFields('seedance-2.5-avatar').resolution.default).toBe('720p')
    expect(studioShownValue('seedance-2.5-avatar', {}, 'resolution')).toBe('480p')
  })

  it('die eigene Wahl geht vor, und der Preis rechnet mit demselben Wert wie die Anzeige', () => {
    expect(studioShownValue('seedance-2.5-avatar', { resolution: '720p' }, 'resolution')).toBe('720p')
    const shown = studioShownValue('seedance-2.5', {}, 'resolution')
    expect(studioPreviewCredits('seedance-2.5', {}, 5)).toBe(studioPreviewCredits('seedance-2.5', { resolution: shown }, 5))
  })

  it('ein klassisches Modell zeigt, was gesetzt ist', () => {
    expect(studioShownValue('flux-schnell', { steps: 4 }, 'steps')).toBe(4)
    expect(studioShownValue('flux-schnell', {}, 'steps')).toBeUndefined()
  })
})

describe('die Klappe im Create-Tab', () => {
  beforeEach(() => {
    useCreateStore.setState({ backend: 'cloud', isGenerating: false, error: null, source: null, cloudStudioOptions: {} })
  })
  afterEach(cleanup)

  it('zeigt bei Seedance 2.5 Avatar 480p und nach eigener Wahl die eigene', () => {
    const first = render(<StudioParams model="seedance-2.5-avatar" />)
    expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('480p')
    first.unmount()
    useCreateStore.setState({ cloudStudioOptions: { resolution: '720p' } })
    render(<StudioParams model="seedance-2.5-avatar" />)
    expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('720p')
  })
})
