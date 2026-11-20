// @vitest-environment jsdom
/**
 * The box, 03.10.2026: the card in the Model Manager read "Noct Q (Qwen-Image
 * 2.1, Unfiltered)", the model picker read "NoctQ V4 int8 convrot". A file the
 * catalogue knows carries the catalogue's name in the picker, the file name as
 * its tooltip; any other file reads as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ModelChip } from '../ModelChip'
import { useCreateStore } from '../../../../stores/createStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { catalogModelName, localModelLabel } from '../../../../lib/local-model-name'
import { getImageBundles, getVideoBundles } from '../../../../api/model-bundles'

const NOCT = 'NoctQ_V4_int8_convrot.safetensors'
const OWN = 'my_own_merge_v3.safetensors'

beforeEach(() => {
  useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: false })
  useCreateStore.setState({
    backend: 'local',
    imageModel: NOCT,
    imageModelList: [
      { name: NOCT, type: 'qwenimage' },
      { name: 'qwen_image_2.1_int8_convrot.safetensors', type: 'qwenimage' },
      { name: OWN, type: 'sdxl' },
    ],
  } as never)
  useCreateStore.getState().setIntent('image')
  render(<ModelChip />)
})
afterEach(() => cleanup())

const rows = () => {
  fireEvent.click(screen.getByRole('button'))
  return Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[]
}
const rowOf = (text: string) => rows().find((r) => r.textContent?.includes(text))

describe('the local model picker', () => {
  it('shows a catalogue file under the catalogue name, the file name as tooltip', () => {
    const row = rowOf('Noct Q V4 (INT8)')
    expect(row, 'no row named after the catalogue file').toBeTruthy()
    expect(row!.getAttribute('title')).toBe(NOCT)
    expect(document.body.textContent).not.toContain('NoctQ V4 int8 convrot')
  })

  it('names the picked model the same way on the closed field', () => {
    const closed = screen.getByRole('button')
    expect(closed.textContent).toContain('Noct Q V4 (INT8)')
    expect(closed.querySelector('[title]')?.getAttribute('title')).toBe(NOCT)
  })

  it('keeps the file name for a file the catalogue does not know, the whole of it as tooltip', () => {
    // Persona walk, Fund 17: where a name is cut off, its tooltip says it whole.
    const row = rowOf('my own merge v3')
    expect(row).toBeTruthy()
    expect(row!.getAttribute('title')).toBe(OWN)
  })

  it('may take the room the name needs: up to 360 px, on every platform', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve(__dirname, '../ModelChip.tsx'), 'utf-8')
    const local = source.slice(source.indexOf('function LocalModelChip'))
    expect(local).toContain('className="min-w-[150px] max-w-[360px]"')
    expect(local).not.toContain('max-w-[230px]')
  })

  it('still finds a catalogue model by its file name in the search', () => {
    rows()
    fireEvent.change(document.querySelector('input') as HTMLInputElement, { target: { value: 'noctq_v4' } })
    const left = Array.from(document.querySelectorAll('[role="option"]'))
    expect(left).toHaveLength(1)
    expect(left[0].textContent).toContain('Noct Q V4 (INT8)')
  })
})

describe('catalogModelName', () => {
  it('knows the file through a folder prefix and in any case', () => {
    expect(catalogModelName(NOCT)).toBe('Noct Q V4 (INT8)')
    expect(catalogModelName(`unfiltered\\${NOCT.toUpperCase()}`)).toBe('Noct Q V4 (INT8)')
    expect(catalogModelName('z_image_bf16.safetensors')).toBe('Z-Image Base BF16')
    expect(catalogModelName(OWN)).toBeNull()
    expect(localModelLabel(OWN)).toEqual({ label: 'my own merge v3' })
  })

  it('gives every main model of the catalogue a name of its own', () => {
    const main = [...getImageBundles(), ...getVideoBundles()].flatMap((b) => b.files)
      .filter((f) => f.subfolder === 'checkpoints' || f.subfolder === 'diffusion_models')
    const labels = new Map<string, string>()
    for (const f of main) labels.set(f.filename!, catalogModelName(f.filename!)!)
    expect([...labels.values()].every(Boolean)).toBe(true)
    // Two files never share a label, or the picker would show two rows alike.
    expect(new Set(labels.values()).size).toBe(labels.size)
  })
})
