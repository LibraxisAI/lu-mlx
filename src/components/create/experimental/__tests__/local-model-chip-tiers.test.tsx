// @vitest-environment jsdom
/**
 * Der lokale Modellwaehler ordnet nach Stufe, wie der Cloud-Waehler.
 *
 * 02.10.2026: "Best" oben mit kleiner Marke, Aeltere gesammelt unten
 * unter "Older models", nichts wird versteckt, Reihenfolge innerhalb einer
 * Stufe bleibt wie die Liste sie liefert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../../../hooks/useContentPolicy', () => ({
  useContentPolicy: () => 'soft' as const,
  primeContentPolicyCache: vi.fn(),
}))

import { ModelChip } from '../ModelChip'
import { useCreateStore } from '../../../../stores/createStore'
import { OLDER_GROUP } from '../../../../lib/render/model-tier'
import { classifyModel, type ClassifiedModel } from '../../../../api/comfyui'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { neuerServer, alterServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { CLOUD_GROUP } from '../ModelChip'

const model = (name: string): ClassifiedModel =>
  ({ name, type: classifyModel(name), folder: 'checkpoints' }) as unknown as ClassifiedModel

beforeEach(() => {
  cleanup()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Hinter den lokalen Zeilen haengen die Cloud-Hinweiszeilen; nur die ersten n gehoeren zur Liste. */
function lies(n: number) {
  render(<ModelChip />)
  fireEvent.click(screen.getByRole('button'))
  const liste = document.querySelector('.lu-elevated') as HTMLElement
  if (!liste) throw new Error('Liste nicht offen')
  const zeilen = Array.from(liste.querySelectorAll('button')).map((b) => ({
    name: (b.querySelector('.truncate')?.textContent ?? '').trim(),
    best: Array.from(b.querySelectorAll('span')).some((s) => s.textContent === 'Best'),
    // Der Kopf ueber der Zeile: sein Name, ohne die Anzahl daneben.
    davor: b.previousElementSibling?.querySelector('b')?.textContent ?? '',
  }))
  return zeilen.slice(0, n)
}

describe('lokaler Bildwaehler', () => {
  it('Beste oben mit Marke, Aeltere unten unter einer einzigen Zwischenzeile', () => {
    useCreateStore.setState({
      backend: 'local',
      imageModelList: [
        model('Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors'),
        model('chroma1-hd.safetensors'),
        model('qwen_image_2.1_int8_convrot.safetensors'),
        model('flux1-dev-fp8.safetensors'),
        model('z_image_turbo_bf16.safetensors'),
      ],
    })
    useCreateStore.getState().setIntent('image')
    const zeilen = lies(5)
    expect(zeilen).toHaveLength(5)
    expect(zeilen.slice(0, 2).every((z) => z.best)).toBe(true)
    expect(zeilen.slice(2).some((z) => z.best)).toBe(false)
    expect(zeilen.filter((z) => z.davor === OLDER_GROUP)).toHaveLength(1)
    expect(zeilen[3].davor).toBe(OLDER_GROUP)
    expect(zeilen[2].name).toMatch(/chroma/i)
  })

  it('der geschlossene Waehler zeigt keine Marke', () => {
    useCreateStore.setState({ backend: 'local', imageModelList: [model('z_image_turbo_bf16.safetensors')] })
    useCreateStore.getState().setIntent('image')
    render(<ModelChip />)
    expect(screen.queryByText('Best')).toBeNull()
    expect(screen.queryByText(OLDER_GROUP)).toBeNull()
  })
})

describe('lokaler Videowaehler', () => {
  it('LTX 2.5 und MiniMax H3 oben, LTX 2.3 und Wan 2.1 unten', () => {
    useCreateStore.setState({
      backend: 'local',
      videoModelList: [
        model('ltx-2.3-22b-distilled-fp8.safetensors'),
        model('wan2.2_ti2v_5B_fp16.safetensors'),
        model('ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'),
        model('wan2.1_t2v_14B_fp8_e4m3fn.safetensors'),
      ],
    })
    useCreateStore.getState().setIntent('video')
    const zeilen = lies(4)
    expect(zeilen[0].best).toBe(true)
    expect(zeilen[0].name).toMatch(/2\.5/)
    expect(zeilen[2].davor).toBe(OLDER_GROUP)
    expect(zeilen.filter((z) => z.davor === OLDER_GROUP)).toHaveLength(1)
    expect(zeilen).toHaveLength(4)
  })
})

// The box, 03.10.2026: the hosted models at the end of the local picker stood
// under "Older models". They carry no group, and the list draws a heading only
// where the group changes, so they ran on under the last heading. They have a
// heading of their own now, whether the server sends a tier or not.
describe('the hosted models at the end of the local picker', () => {
  function cloudRows() {
    render(<ModelChip />)
    fireEvent.click(screen.getByRole('button'))
    const liste = document.querySelector('.lu-elevated') as HTMLElement
    const rows = Array.from(liste.querySelectorAll('button'))
    // Each row is a wrapper holding an optional heading and the button. The
    // heading a row stands under is the nearest one above it.
    const headingOf = (b: Element) => {
      for (let row: Element | null = b.parentElement; row; row = row.previousElementSibling) {
        const head = row.querySelector(':scope > div')
        // The head reads its name and, beside it, how many rows stand under it.
        if (head) return head.querySelector('b')?.textContent ?? ''
      }
      return ''
    }
    return rows
      .filter((b) => Array.from(b.querySelectorAll('span')).some((sp) => sp.textContent === 'Cloud'))
      .map((b) => headingOf(b))
  }

  it.each([['a server with tiers', neuerServer], ['an older server without tiers', alterServer]])(
    'stand under their own heading, not under "Older models" (%s)',
    (_name, catalog) => {
      useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: true })
      useCloudCatalogStore.setState({ models: catalog() })
      useCreateStore.setState({
        backend: 'local',
        imageModelList: [model('z_image_turbo_bf16.safetensors'), model('Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors')],
      })
      useCreateStore.getState().setIntent('image')
      const headings = cloudRows()
      expect(headings.length).toBeGreaterThan(0)
      expect(CLOUD_GROUP).toBe('LU Cloud')
      for (const h of headings) expect(h).toBe(CLOUD_GROUP)
      expect(screen.getAllByText(OLDER_GROUP)).toHaveLength(1)
    },
  )
})
