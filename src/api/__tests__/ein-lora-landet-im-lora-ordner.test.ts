/**
 * Ein LoRA-Treffer aus der CivitAI-Suche gehoert in `loras` und nirgendwo
 * sonst.
 *
 * `searchCivitaiModels` bestimmt den Zielordner zweimal: einmal aus dem
 * gesuchten Typ, danach noch einmal aus dem NAMEN des Treffers ("flux", "wan",
 * "hunyuan" heissen `diffusion_models`). Die zweite Regel ist fuer
 * Checkpoints richtig und fuer alles andere falsch: der Name eines LoRA sagt,
 * gegen welches Basismodell es trainiert wurde, nicht welche Art Datei es ist.
 * "Flux Realism LoRA" waere damit nach `diffusion_models` geschrieben worden,
 * wo der LoraLoader nicht hinsieht. Der LoRA-Reiter in Models haette also
 * heruntergeladen, was der LoRA-Stapel in Create nie anbieten kann.
 *
 * Run: npx vitest run src/api/__tests__/ein-lora-landet-im-lora-ordner.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchExternal = vi.fn()

vi.mock('../backend', () => ({
  backendCall: vi.fn(),
  fetchExternal: (...args: unknown[]) => fetchExternal(...args),
}))

import { searchCivitaiModels } from '../discover'

/** Eine CivitAI-Antwort mit genau einem Treffer des gegebenen Namens. */
function antwortMit(name: string): string {
  return JSON.stringify({
    items: [{
      id: 1,
      name,
      stats: { downloadCount: 10 },
      creator: { username: 'someone' },
      modelVersions: [{
        downloadUrl: 'https://civitai.com/api/download/models/1',
        files: [{ name: 'x.safetensors', sizeKB: 1024 }],
        images: [],
      }],
    }],
  })
}

beforeEach(() => { fetchExternal.mockReset() })

describe('der Zielordner eines CivitAI-Treffers', () => {
  it('THE FIX: ein LoRA geht nach loras, auch wenn "Flux" im Namen steht', async () => {
    fetchExternal.mockResolvedValue(antwortMit('Flux Realism LoRA'))
    const hits = await searchCivitaiModels('realism', 'LORA')
    expect(hits).toHaveLength(1)
    expect(hits[0].subfolder).toBe('loras')
  })

  it('und ein LoRA ohne solchen Namen genauso', async () => {
    fetchExternal.mockResolvedValue(antwortMit('Detail Enhancer'))
    const hits = await searchCivitaiModels('detail', 'LORA')
    expect(hits[0].subfolder).toBe('loras')
  })

  it('die Typfrage geht auch so an CivitAI', async () => {
    fetchExternal.mockResolvedValue(antwortMit('Detail Enhancer'))
    await searchCivitaiModels('detail', 'LORA')
    expect(fetchExternal).toHaveBeenCalledTimes(1)
    expect(String(fetchExternal.mock.calls[0][0])).toContain('types=LORA')
  })

  // GEGENPROBE: die Namensregel lebt weiter, sie gilt nur fuer Checkpoints.
  // Faellt sie ganz weg, faellt dieser Fall auf.
  it('GEGENPROBE: ein Checkpoint mit "Flux" im Namen geht weiter nach diffusion_models', async () => {
    fetchExternal.mockResolvedValue(antwortMit('Flux Dev'))
    const hits = await searchCivitaiModels('flux', 'Checkpoint')
    expect(hits[0].subfolder).toBe('diffusion_models')
  })

  it('GEGENPROBE: ein Checkpoint ohne solchen Namen bleibt bei checkpoints', async () => {
    fetchExternal.mockResolvedValue(antwortMit('Some SDXL Mix'))
    const hits = await searchCivitaiModels('sdxl', 'Checkpoint')
    expect(hits[0].subfolder).toBe('checkpoints')
  })
})

/**
 * The Mac's LoRA lane (09.10.2026) asks the same search for LoRAs of one base
 * model and for a file its folder can list. Without those two words the
 * search is what it was.
 */
describe('die Suche fuer den LoRA-Ordner am Mac', () => {
  const zweiDateien = JSON.stringify({
    items: [
      {
        id: 1, name: 'Restore', modelVersions: [{
          downloadUrl: 'https://civitai.com/api/download/models/10',
          files: [
            { name: 'Restore workflow.json', sizeKB: 12, downloadUrl: 'https://civitai.com/api/download/models/10?type=Archive' },
            { name: 'restore.safetensors', sizeKB: 2048, downloadUrl: 'https://civitai.com/api/download/models/10?type=Model' },
          ],
        }],
      },
      { id: 2, name: 'Only a workflow', modelVersions: [{ downloadUrl: 'https://civitai.com/api/download/models/20', files: [{ name: 'flow.json', sizeKB: 3 }] }] },
      { id: 3, name: 'Plain', modelVersions: [{ downloadUrl: 'https://civitai.com/api/download/models/30', files: [{ name: 'plain.SAFETENSORS', sizeKB: 1024 }] }] },
    ],
  })

  it('fragt nach dem Basismodell, unter dem Namen, den CivitAI fuehrt', async () => {
    fetchExternal.mockResolvedValue(antwortMit('Detail'))
    await searchCivitaiModels('detail', 'LORA', undefined, 'civitai.com', { baseModel: 'Qwen 2.1', safetensorsOnly: true })
    const url = new URL(String(fetchExternal.mock.calls[0][0]))
    expect(url.searchParams.get('baseModels')).toBe('Qwen 2.1')
    expect(url.searchParams.get('types')).toBe('LORA')
  })

  it('nimmt die erste .safetensors-Datei eines Treffers mit IHRER Adresse und laesst Treffer ohne eine weg', async () => {
    fetchExternal.mockResolvedValue(zweiDateien)
    const hits = await searchCivitaiModels('x', 'LORA', undefined, 'civitai.com', { baseModel: 'Qwen 2.1', safetensorsOnly: true })
    expect(hits.map((h) => [h.id, h.filename, h.downloadUrl])).toEqual([
      [1, 'restore.safetensors', 'https://civitai.com/api/download/models/10?type=Model'],
      [3, 'plain.SAFETENSORS', 'https://civitai.com/api/download/models/30'],
    ])
    expect(hits.every((h) => h.subfolder === 'loras')).toBe(true)
  })

  it('GEGENPROBE: ohne die beiden Worte bleibt die Suche, wie sie war', async () => {
    fetchExternal.mockResolvedValue(zweiDateien)
    const hits = await searchCivitaiModels('x', 'LORA')
    expect(new URL(String(fetchExternal.mock.calls[0][0])).searchParams.has('baseModels')).toBe(false)
    // Every hit, each with its first file and the version's address.
    expect(hits.map((h) => [h.id, h.filename, h.downloadUrl])).toEqual([
      [1, 'Restore workflow.json', 'https://civitai.com/api/download/models/10'],
      [2, 'flow.json', 'https://civitai.com/api/download/models/20'],
      [3, 'plain.SAFETENSORS', 'https://civitai.com/api/download/models/30'],
    ])
  })
})
