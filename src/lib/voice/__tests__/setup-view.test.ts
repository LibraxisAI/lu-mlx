import { describe, expect, it } from 'vitest'
import type { VoiceLoopInstallStatus, VoiceLoopRequirements } from '../../../api/voice-loop'
import {
  voiceSetupCredits,
  voiceSetupItems,
  voiceSetupMode,
  voiceSetupProgress,
  voiceSetupTotals,
} from '../setup-view'

function requirements(patch: Partial<VoiceLoopRequirements> = {}): VoiceLoopRequirements {
  return {
    supported: true,
    unsupportedReason: null,
    installed: false,
    installDir: '/data/voice',
    python: { version: '3.12.15', installed: false, downloadBytes: 25_013_243 },
    packages: { installed: false, downloadBytesEstimate: 335_000_000, diskBytesEstimate: 1_100_000_000, versions: { 'pipecat-ai': '1.12.0' } },
    models: [
      { id: 'stt', name: 'Whisper base.en', role: 'stt', license: 'MIT', attribution: null, bytes: 147_769_510, installed: false },
      { id: 'tts', name: 'Pocket TTS', role: 'tts', license: 'CC-BY-4.0', attribution: 'Pocket TTS by Kyutai, licensed under CC BY 4.0.', bytes: 219_088_535, installed: false },
      { id: 'alba', name: 'alba', role: 'tts-voice', license: 'CC-BY-4.0', attribution: 'Voice "alba" from recordings by Alba MacKenna, licensed under CC BY 4.0.', bytes: 6_194_424, installed: false },
    ],
    modelsBytes: 373_052_469,
    voice: 'alba',
    voices: [{ name: 'alba', license: 'CC-BY-4.0', attribution: 'Voice "alba" from recordings by Alba MacKenna, licensed under CC BY 4.0.', bytes: 6_194_424, installed: false }],
    downloadBytes: 733_065_712,
    diskBytesNeeded: 2_300_000_000,
    diskBytesFree: 50_000_000_000,
    enoughSpace: true,
    ...patch,
  }
}

function status(patch: Partial<VoiceLoopInstallStatus> = {}): VoiceLoopInstallStatus {
  return {
    status: 'running', phase: 'python', message: 'Downloading Python.', currentFile: null,
    bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0, logs: [], detail: [], error: null, ...patch,
  }
}

describe('voiceSetupMode', () => {
  it('is loading until the requirements are known, unavailable when they cannot be read', () => {
    expect(voiceSetupMode(null, null, null)).toBe('loading')
    expect(voiceSetupMode(null, null, 'no backend')).toBe('unavailable')
  })

  it('is unsupported on a machine that cannot run it, whatever else is reported', () => {
    const req = requirements({ supported: false, unsupportedReason: 'Intel Mac', python: null })
    expect(voiceSetupMode(req, status(), null)).toBe('unsupported')
  })

  it('follows the setup: needed, installing, cancelled, failed, ready', () => {
    const req = requirements()
    expect(voiceSetupMode(req, null, null)).toBe('needed')
    expect(voiceSetupMode(req, status({ status: 'idle', phase: 'idle' }), null)).toBe('needed')
    expect(voiceSetupMode(req, status(), null)).toBe('installing')
    expect(voiceSetupMode(req, status({ status: 'cancelled', phase: 'idle' }), null)).toBe('cancelled')
    expect(voiceSetupMode(req, status({ status: 'error', phase: 'idle', error: 'disk full' }), null)).toBe('failed')
    expect(voiceSetupMode(requirements({ installed: true }), status({ status: 'complete', phase: 'done' }), null)).toBe('ready')
  })

  it('shows a repair of an installed engine as installing', () => {
    expect(voiceSetupMode(requirements({ installed: true }), status({ phase: 'packages' }), null)).toBe('installing')
  })

  it('is ready when installed even if an older setup once failed', () => {
    expect(voiceSetupMode(requirements({ installed: true }), status({ status: 'error', phase: 'idle' }), null)).toBe('ready')
  })
})

describe('what the setup lists', () => {
  it('lists Python, the packages and every model with size and purpose', () => {
    const items = voiceSetupItems(requirements())
    expect(items.map((i) => i.title)).toEqual(['Python 3.12.15', 'Speech packages', 'Whisper base.en', 'Pocket TTS', 'alba'])
    expect(items[0].size).toBe('23.9 MB')
    expect(items[1].size).toBe('about 319.5 MB')
    expect(items[2]).toMatchObject({ size: '140.9 MB', purpose: 'Turns what you say into text.', license: 'MIT' })
    expect(items[3].purpose).toBe('Speaks the answers.')
    expect(items.every((i) => i.purpose.length > 10 && !i.installed)).toBe(true)
  })

  it('leaves Python out where the machine is not supported', () => {
    expect(voiceSetupItems(requirements({ python: null })).map((i) => i.key)).not.toContain('python')
  })

  it('marks the parts that are already there', () => {
    const req = requirements()
    req.python!.installed = true
    req.models[0].installed = true
    expect(voiceSetupItems(req).filter((i) => i.installed).map((i) => i.key)).toEqual(['python', 'stt'])
  })

  it('sums up download, disk and free space', () => {
    expect(voiceSetupTotals(requirements())).toEqual({ download: 'about 699.1 MB', disk: 'about 2.1 GB', free: '46.6 GB', enoughSpace: true })
    expect(voiceSetupTotals(requirements({ diskBytesFree: null, enoughSpace: false }))).toMatchObject({ free: null, enoughSpace: false })
  })

  it('gives the credit line a license asks for, and the license name where it asks for none', () => {
    expect(voiceSetupCredits(requirements())).toEqual([
      'Whisper base.en: MIT license.',
      'Pocket TTS by Kyutai, licensed under CC BY 4.0.',
      'Voice "alba" from recordings by Alba MacKenna, licensed under CC BY 4.0.',
    ])
  })
})

describe('voiceSetupProgress', () => {
  it('marks earlier phases done, the current one active and later ones open', () => {
    const progress = voiceSetupProgress(status({ phase: 'packages' }))
    expect(progress.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'todo'])
  })

  it('shows bytes, speed and file while a download counts bytes', () => {
    const progress = voiceSetupProgress(status({ phase: 'models', message: 'Downloading the speech models.', currentFile: 'Whisper base.en', bytesDone: 186_526_234, bytesTotal: 373_052_469, bytesPerSecond: 4_000_000 }))
    expect(progress.fraction).toBeCloseTo(0.5, 2)
    expect(progress.line).toBe('Whisper base.en · 177.9 MB of 355.8 MB · 3.8 MB/s')
    expect(progress.headline).toBe('Downloading the speech models.')
  })

  it('shows what pip is doing in the packages phase instead of a percentage', () => {
    const progress = voiceSetupProgress(status({ phase: 'packages', detail: ['Collecting torch', 'Downloading torch-2.14.1 (80.1 MB)'] }))
    expect(progress.fraction).toBeNull()
    expect(progress.line).toBe('Downloading torch-2.14.1 (80.1 MB)')
  })

  it('pulses instead of standing at 0 percent while pip has announced a size and counted no byte', () => {
    // Seen on Windows: the bar stood at 0 % for the five minutes of the longest step.
    const announced = voiceSetupProgress(status({ phase: 'packages', bytesDone: 0, bytesTotal: 124_000_000, detail: ['Downloading torch (124.0 MB)'] }))
    expect(announced.fraction).toBeNull()
    const lookups = voiceSetupProgress(status({ phase: 'packages', bytesDone: 3_700, bytesTotal: 335_000_000 }))
    expect(lookups.fraction).toBeNull()
    const counting = voiceSetupProgress(status({ phase: 'packages', bytesDone: 62_000_000, bytesTotal: 124_000_000 }))
    expect(counting.fraction).toBeCloseTo(0.5, 2)
  })

  it('still says something in the packages phase before pip printed a line', () => {
    expect(voiceSetupProgress(status({ phase: 'packages' })).line).toMatch(/longest step/)
  })

  it('has no fraction for a phase without byte totals and marks all steps done at the end', () => {
    expect(voiceSetupProgress(status({ phase: 'environment' })).fraction).toBeNull()
    expect(voiceSetupProgress(status({ status: 'complete', phase: 'done' })).steps.every((s) => s.state === 'done')).toBe(true)
  })
})
