/**
 * The Mac has a second video engine since 3.0.6 (ltx-2-mlx, for the LTX packs
 * that are quantized already). It installs with the first model that needs
 * it, inside that model's own install. These tests hold the three places the
 * surface has to know about it:
 *
 *  - Get on such a pack does not set the first engine up beforehand,
 *  - Get on any other video model still does,
 *  - and either engine counts as "a video engine is set up".
 *
 * Run: npx vitest run src/lib/__tests__/video-engines.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const calls: string[] = []
let videoStatus: Record<string, unknown> = {}

vi.mock('../../api/mlx-image', () => ({
  mlxStatus: vi.fn(),
  listMlxImageModels: vi.fn(),
  installMlxImageModel: vi.fn(),
  getMlxImageInstallStatus: vi.fn(),
  installMlxImageEngine: vi.fn(),
  getMlxImageEngineStatus: vi.fn(),
}))
vi.mock('../../api/mlx-video', () => ({
  getVideoStatus: vi.fn(async () => videoStatus),
  listVideoModels: vi.fn(async () => []),
  installMlxVideo: vi.fn(async () => { calls.push('video_install_mlx'); return { ok: true, status: 'installing' } }),
  getMlxInstallStatus: vi.fn(async () => ({ status: 'complete', logs: [], error: null })),
  installVideoModel: vi.fn(async (id: string) => { calls.push(`video_install_model:${id}`); return { ok: true, status: 'installing', id } }),
  getModelInstallStatus: vi.fn(async () => ({ status: 'complete', logs: [], error: null })),
}))
vi.mock('../../stores/mlxInstallStore', () => ({
  mlxLaneGeneration: () => 0,
  useMlxInstallStore: {
    getState: () => ({
      watch: vi.fn(),
      begin: vi.fn(),
      abandon: vi.fn(),
      settled: async () => {},
      starting: <T>(_lane: string, call: Promise<T>) => call,
    }),
  },
}))
vi.mock('../bundle-install', () => ({ waitOrAbort: vi.fn(async () => {}) }))

import { installMlxModel } from '../../api/mlx-install'
import { QUANTIZED_LTX_FAMILY, anyVideoEngineReady, videoModelBringsItsEngine } from '../video-engines'

const WURZEL = resolve(__dirname, '../../..')

describe('the second video engine', () => {
  beforeEach(() => {
    calls.length = 0
    videoStatus = { available: true, appleSilicon: true, mlxInstalled: false, ltx2MlxInstalled: false, installedModels: [] }
  })

  it('names the family the way Rust does', () => {
    const rust = readFileSync(resolve(WURZEL, 'src-tauri/src/commands/video_ltx2mlx.rs'), 'utf8')
    expect(rust).toContain(`pub(super) const FAMILY: &str = "${QUANTIZED_LTX_FAMILY}";`)
    expect(videoModelBringsItsEngine(QUANTIZED_LTX_FAMILY)).toBe(true)
    for (const family of ['ltx_2', 'wan_2', '', undefined]) expect(videoModelBringsItsEngine(family)).toBe(false)
  })

  it('Get on a quantized LTX pack does not set the first engine up', async () => {
    await installMlxModel('video', { id: 'ltx-2.3-q8', name: 'LTX-2.3 Distilled 8-bit', family: QUANTIZED_LTX_FAMILY })
    expect(calls).toEqual(['video_install_model:ltx-2.3-q8'])
  })

  it('COUNTER-CHECK: Get on a model of the first engine sets that engine up first', async () => {
    await installMlxModel('video', { id: 'wan22-ti2v-5b-q8', name: 'Wan 2.2 TI2V 5B 8-bit', family: 'wan_2' })
    expect(calls).toEqual(['video_install_mlx', 'video_install_model:wan22-ti2v-5b-q8'])
    // Having the second engine does not stand in for the first.
    calls.length = 0
    videoStatus = { ...videoStatus, ltx2MlxInstalled: true }
    await installMlxModel('video', { id: 'ltx-2.3-dev', name: 'LTX-2.3 Dev', family: 'ltx_2' })
    expect(calls).toEqual(['video_install_mlx', 'video_install_model:ltx-2.3-dev'])
    // A caller that does not say the family gets the old behaviour.
    calls.length = 0
    await installMlxModel('video', { id: 'ltx-2.3-q8', name: 'LTX-2.3 Distilled 8-bit' })
    expect(calls[0]).toBe('video_install_mlx')
  })

  it('either engine is a video engine that is set up', () => {
    expect(anyVideoEngineReady(null)).toBe(false)
    expect(anyVideoEngineReady({ mlxInstalled: false })).toBe(false)
    expect(anyVideoEngineReady({ mlxInstalled: true })).toBe(true)
    expect(anyVideoEngineReady({ mlxInstalled: false, ltx2MlxInstalled: true })).toBe(true)
  })

  it('Create and the agent tool do not turn a Mac away that has the second engine only', () => {
    // Both asked `!status.mlxInstalled` and would have refused a Mac whose one
    // video model is a quantized LTX pack.
    for (const datei of ['src/hooks/useCreate.ts', 'src/api/mcp/builtin-tools.ts']) {
      const quelle = readFileSync(resolve(WURZEL, datei), 'utf8')
      expect(quelle, datei).toContain('!status.mlxInstalled && !status.ltx2MlxInstalled')
      expect(quelle.match(/!status\.mlxInstalled\)/), datei).toBeNull()
    }
    // And Create treats such a pack as an LTX, not as a Wan.
    const api = readFileSync(resolve(WURZEL, 'src/api/mlx-video.ts'), 'utf8')
    expect(api).toContain("family === 'ltx_2' || family === 'ltx_2q' ? 'ltx' : 'wan'")
  })
})
