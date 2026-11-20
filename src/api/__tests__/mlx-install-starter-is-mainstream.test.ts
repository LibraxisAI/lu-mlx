/**
 * "Download & install" in Create picks a mainstream model.
 *
 * Persona walk of the Mac app, 09.10.2026: a newcomer on a MacBook Air opened
 * Create, went to Video and pressed "Download & install". The setup took the
 * smallest video model of the whole catalogue, and that is NSFW Wan 1.3B, an
 * adult fine-tune from the Unfiltered side (14.7 GB against the 18 GB of
 * Wan 2.1 T2V 1.3B). Nobody had chosen it.
 *
 * Real run of the same day: the smallest mainstream video model, Wan 2.1 T2V
 * 1.3B, took half an hour for five seconds on an M5 Pro, without sound.
 * LTX-2.3 Distilled 4-bit took 64 s. So the setup takes the entry the
 * catalogue marks as the starter where it sits in this Mac's memory, the
 * smallest that sits there otherwise, and nothing where none does.
 *
 * Run: npx vitest run src/api/__tests__/mlx-install-starter-is-mainstream.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let replies: Record<string, unknown> = {}
const calls: Array<{ cmd: string; args: unknown }> = []

vi.mock('../backend', () => ({
  backendCall: async (cmd: string, payload?: { args?: unknown }) => {
    calls.push({ cmd, args: payload?.args })
    if (!(cmd in replies)) throw new Error(`unexpected command: ${cmd}`)
    return replies[cmd]
  },
  isTauri: () => true,
  isMacOS: () => true,
}))

import { installMlxStack, starterChoice, starterPick } from '../mlx-install'
import { resetMlxInstallStoreForTest } from '../../stores/mlxInstallStore'

const model = (id: string, sizeGB: number, more: Record<string, unknown> = {}) => ({
  id, name: id, repo: `e2e/${id}`, family: 'wan_2', sizeGB, minRamGB: 16, defaultFrames: 81,
  needsConvert: false, unfiltered: false, requiresImage: false, acceptsImage: false, installed: false, description: '', ...more,
})
const complete = { status: 'complete', logs: [], error: null, download_progress: 0, download_total: 0, download_speed: 0 }

describe('the starter model of the Create setup', () => {
  it('is the smallest mainstream model, also when an unfiltered one is smaller', () => {
    const pick = starterPick([
      { id: 'wan', sizeBytes: 18e9, installed: false, unfiltered: false },
      { id: 'adult', sizeBytes: 14.7e9, installed: false, unfiltered: true },
      { id: 'ltx', sizeBytes: 20.5e9, installed: false, unfiltered: false },
    ])
    expect(pick?.id).toBe('wan')
  })

  it('leaves out what is installed and what cannot start from text', () => {
    const pick = starterPick([
      { id: 'here', sizeBytes: 1e9, installed: true, unfiltered: false },
      { id: 'needs-image', sizeBytes: 2e9, installed: false, unfiltered: false, requiresImage: true },
      { id: 'text', sizeBytes: 9e9, installed: false, unfiltered: false, requiresImage: false },
    ])
    expect(pick?.id).toBe('text')
  })

  it('is nothing when only the unfiltered side is left: that side is chosen in the Model Manager', () => {
    expect(starterPick([
      { id: 'here', sizeBytes: 18e9, installed: true, unfiltered: false },
      { id: 'adult', sizeBytes: 14.7e9, installed: false, unfiltered: true },
    ])).toBeNull()
  })
})

describe('the starter and the memory of this Mac', () => {
  const GB = 1e9
  // The three a fresh Mac chooses among, as `video_list_models` names them.
  const catalogue = [
    { id: 'ltx-2.3-q4', sizeBytes: 20.5 * GB, installed: false, unfiltered: false, minRamGB: 16, recommendedRamGB: 16, starter: true },
    { id: 'wan21-t2v-1.3b', sizeBytes: 18 * GB, installed: false, unfiltered: false, minRamGB: 16, recommendedRamGB: 32 },
    { id: 'wan22-ti2v-5b-q8', sizeBytes: 19.6 * GB, installed: false, unfiltered: false, minRamGB: 32, recommendedRamGB: 32 },
    { id: 'nsfw-wan21-1.3b', sizeBytes: 14.7 * GB, installed: false, unfiltered: true, minRamGB: 16, recommendedRamGB: 32 },
  ]

  it('is the entry the catalogue marks, not the smallest, on every Mac it fits on', () => {
    // 15.6 is what a Mac sold as 16 GB can report: rounded, as the tiles do.
    for (const memoryGb of [15.6, 16, 24, 32, 48, 128]) {
      expect(starterPick(catalogue, memoryGb)?.id, `${memoryGb} GB`).toBe('ltx-2.3-q4')
    }
    // Memory nobody could read holds nothing back.
    expect(starterPick(catalogue, null)?.id).toBe('ltx-2.3-q4')
    expect(starterPick(catalogue)?.id).toBe('ltx-2.3-q4')
  })

  it('reads the threshold from the entry: a starter that needs more gives way to the smallest that fits', () => {
    const heavier = catalogue.map((m) => (m.starter ? { ...m, minRamGB: 24, recommendedRamGB: 24 } : m))
    expect(starterPick(heavier, 24)?.id).toBe('ltx-2.3-q4')
    // On 16 GB nothing fits: Wan is recommended from 32 GB on.
    expect(starterChoice(heavier, 16)).toEqual({ pick: null, reason: 'memory', needGb: 24 })
    // With the starter installed, the smallest of what fits is next.
    const rest = catalogue.map((m) => (m.starter ? { ...m, installed: true } : m))
    expect(starterPick(rest, 48)?.id).toBe('wan21-t2v-1.3b')
    expect(starterChoice(rest, 16)).toEqual({ pick: null, reason: 'memory', needGb: 32 })
  })

  it('takes nothing on a Mac none of them runs on, and says what the least is', () => {
    expect(starterChoice(catalogue, 8)).toEqual({ pick: null, reason: 'memory', needGb: 16 })
    // "Everything is here" is another answer, and the caller tells them apart.
    expect(starterChoice(catalogue.map((m) => ({ ...m, installed: true })), 8)).toEqual({ pick: null, reason: 'installed' })
  })
})

describe('installMlxStack', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    calls.length = 0
    resetMlxInstallStoreForTest()
  })
  afterEach(() => { vi.useRealTimers() })

  const videoList = [
    model('nsfw-wan21-1.3b', 14.7, { unfiltered: true, recommendedRamGB: 32 }),
    model('wan21-t2v-1.3b', 18.0, { recommendedRamGB: 32 }),
    model('ltx-2.3-q4', 20.5, { family: 'ltx_2q', recommendedRamGB: 16, textEncoderGB: 8.1, starter: true }),
  ]
  const freshVideo = { available: false, appleSilicon: true, mlxInstalled: false, ltx2MlxInstalled: false, installedModels: [], running: false }

  it('video: downloads the starter of the catalogue, neither the slow Wan nor the smaller adult fine-tune', async () => {
    replies = {
      video_status: freshVideo,
      video_list_models: videoList,
      system_info: { totalMemory: 16 * 1_073_741_824 },
      video_install_model: { ok: true, status: 'installing' },
      video_install_model_status: complete,
    }
    const said: string[] = []
    const run = installMlxStack('video', (m) => said.push(m))
    await vi.runAllTimersAsync()
    await run
    const install = calls.find((c) => c.cmd === 'video_install_model')
    expect(install?.args).toMatchObject({ id: 'ltx-2.3-q4' })
    // The size it names is what comes down: 20.5 GB and the 8.1 GB of the
    // text encoder, counted as the app counts (28.6e9 bytes are 26.6 GB).
    expect(said.join(' ')).toContain('Downloading ltx-2.3-q4 (26.6 GB)')
    expect(said.join(' ')).not.toContain('nsfw')
    // The pack brings its engine. The other one is not set up for it.
    expect(calls.some((c) => c.cmd === 'video_install_mlx')).toBe(false)
  })

  it('video: a model of the first engine still gets that engine set up first', async () => {
    replies = {
      video_status: freshVideo,
      video_list_models: videoList.map((m) => (m.id === 'ltx-2.3-q4' ? { ...m, installed: true } : m)),
      system_info: { totalMemory: 48 * 1_073_741_824 },
      video_install_mlx: { ok: true, status: 'installing' },
      video_install_mlx_status: complete,
      video_install_model: { ok: true, status: 'installing' },
      video_install_model_status: complete,
    }
    const run = installMlxStack('video')
    await vi.runAllTimersAsync()
    await run
    const order = calls.map((c) => c.cmd).filter((c) => c === 'video_install_mlx' || c === 'video_install_model')
    expect(order).toEqual(['video_install_mlx', 'video_install_model'])
    expect(calls.find((c) => c.cmd === 'video_install_model')?.args).toMatchObject({ id: 'wan21-t2v-1.3b' })
  })

  it('video: on a Mac no starter runs on nothing is downloaded, and the reason is said', async () => {
    replies = {
      video_status: freshVideo,
      video_list_models: videoList,
      system_info: { totalMemory: 8 * 1_073_741_824 },
    }
    const run = installMlxStack('video')
    const outcome = expect(run).rejects.toThrow(
      'The smallest video model to start with needs a Mac with 16 GB of memory, and this one has 8 GB. Nothing is downloaded, because it would not run here. Use LU Cloud for video on this Mac.',
    )
    await vi.runAllTimersAsync()
    await outcome
    expect(calls.some((c) => c.cmd === 'video_install_model' || c.cmd === 'video_install_mlx')).toBe(false)
  })

  it('image: an unfiltered model that is smaller than the starter is not the starter', async () => {
    replies = {
      mlx_status: { installed: true, running: false, port: 47712 },
      mlx_image_models: [
        { ...model('tiny-adult', 1.9, { unfiltered: true }), family: 'diffusers', steps: 20, guidance: 5, defaultSize: 512 },
        { ...model('sd-turbo', 2.6), family: 'diffusers', steps: 4, guidance: 0, defaultSize: 512 },
      ],
      mlx_image_install_model: { ok: true, status: 'installing' },
      mlx_image_install_status: complete,
    }
    const run = installMlxStack('image')
    await vi.runAllTimersAsync()
    await run
    expect(calls.find((c) => c.cmd === 'mlx_image_install_model')?.args).toMatchObject({ id: 'sd-turbo' })
  })
})
