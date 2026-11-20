// What the voice setup panel shows, worked out from what Rust reports.
//
// Two answers come from the backend: what the setup would download
// (`voice_loop_requirements`) and how a running setup is doing
// (`voice_loop_install_status`). This file turns them into the rows, the
// progress line and the one state the panel is in. No React, so every state
// the panel can be in is checked by a plain unit test.

import type {
  VoiceLoopInstallPhase,
  VoiceLoopInstallStatus,
  VoiceLoopRequirements,
} from '../../api/voice-loop'
import { voiceLoopInstallFraction } from '../../api/voice-loop'
import { formatBytes } from '../formatters'

export type VoiceSetupMode =
  /** Nothing is known yet. */
  | 'loading'
  /** The requirements could not be read. */
  | 'unavailable'
  /** This machine cannot run the voice loop. */
  | 'unsupported'
  /** Not installed, nothing running. */
  | 'needed'
  | 'installing'
  /** The user stopped a setup. Finished parts are kept. */
  | 'cancelled'
  | 'failed'
  | 'ready'
  /** The voice engine is being removed from this computer. */
  | 'removing'

export function voiceSetupMode(
  requirements: VoiceLoopRequirements | null,
  status: VoiceLoopInstallStatus | null,
  loadError: string | null,
): VoiceSetupMode {
  if (!requirements) return loadError ? 'unavailable' : 'loading'
  if (!requirements.supported) return 'unsupported'
  // A running setup wins over everything: a repair runs on an installed loop.
  if (status?.status === 'running') return 'installing'
  if (requirements.installed) return 'ready'
  if (status?.status === 'error') return 'failed'
  if (status?.status === 'cancelled') return 'cancelled'
  return 'needed'
}

export interface VoiceSetupItem {
  key: string
  title: string
  /** What this part is for, in the user's words. */
  purpose: string
  /** Download size as text, "about" for a measured estimate. */
  size: string
  installed: boolean
  license: string | null
}

const MODEL_PURPOSE: Record<string, string> = {
  stt: 'Turns what you say into text.',
  tts: 'Speaks the answers.',
  'tts-voice': 'The voice the answers are spoken in.',
}

export function voiceSetupItems(requirements: VoiceLoopRequirements): VoiceSetupItem[] {
  const items: VoiceSetupItem[] = []
  if (requirements.python) {
    items.push({
      key: 'python',
      title: `Python ${requirements.python.version}`,
      purpose: 'Runs the voice engine. A private copy for this app, your own Python is not touched.',
      size: formatBytes(requirements.python.downloadBytes),
      installed: requirements.python.installed,
      license: null,
    })
  }
  items.push({
    key: 'packages',
    title: 'Speech packages',
    purpose: 'Speech recognition, speech output and the audio pipeline between them.',
    size: `about ${formatBytes(requirements.packages.downloadBytesEstimate)}`,
    installed: requirements.packages.installed,
    license: null,
  })
  for (const model of requirements.models) {
    items.push({
      key: model.id,
      title: model.name,
      purpose: MODEL_PURPOSE[model.role] ?? 'A speech model.',
      size: formatBytes(model.bytes),
      installed: model.installed,
      license: model.license || null,
    })
  }
  return items
}

/** The credit lines the model licenses ask for, without duplicates. */
export function voiceSetupCredits(requirements: VoiceLoopRequirements): string[] {
  const lines = requirements.models
    .map((model) => model.attribution?.trim() || (model.license ? `${model.name}: ${model.license} license.` : ''))
    .filter(Boolean)
  return [...new Set(lines)]
}

export interface VoiceSetupTotals {
  download: string
  disk: string
  free: string | null
  enoughSpace: boolean
}

export function voiceSetupTotals(requirements: VoiceLoopRequirements): VoiceSetupTotals {
  return {
    download: `about ${formatBytes(requirements.downloadBytes)}`,
    disk: `about ${formatBytes(requirements.diskBytesNeeded)}`,
    free: requirements.diskBytesFree === null ? null : formatBytes(requirements.diskBytesFree),
    enoughSpace: requirements.enoughSpace,
  }
}

export const VOICE_SETUP_PHASES: ReadonlyArray<{ key: VoiceLoopInstallPhase; label: string }> = [
  { key: 'checking', label: 'Check' },
  { key: 'python', label: 'Python' },
  { key: 'environment', label: 'Environment' },
  { key: 'packages', label: 'Packages' },
  { key: 'models', label: 'Models' },
]

export interface VoiceSetupProgress {
  steps: Array<{ key: string; label: string; state: 'done' | 'active' | 'todo' }>
  /** The sentence Rust wrote for this phase. */
  headline: string
  /** One line under the bar: bytes and speed, or what pip is doing. */
  line: string
  /** 0 to 1 when the phase counts bytes, null when it cannot. */
  fraction: number | null
}

export function voiceSetupProgress(status: VoiceLoopInstallStatus): VoiceSetupProgress {
  const at = VOICE_SETUP_PHASES.findIndex((phase) => phase.key === status.phase)
  const done = status.phase === 'done'
  const steps = VOICE_SETUP_PHASES.map((phase, index) => ({
    key: phase.key,
    label: phase.label,
    state: done || (at >= 0 && index < at) ? ('done' as const) : index === at ? ('active' as const) : ('todo' as const),
  }))
  // A total with next to nothing counted is not "0 percent": pip looks up
  // every package before it fetches the first one, and a few kilobytes of
  // lookups left the bar standing at 0 for 46 seconds (box, 07.10.2026). The
  // bar pulses until one percent is in.
  const measured = voiceLoopInstallFraction(status)
  const fraction = status.phase === 'packages' && (measured === null || measured < 0.01) ? null : measured
  let line = ''
  if (status.phase === 'packages') {
    // pip reports no byte totals. Its own last line says more than "0 %".
    line = status.detail[status.detail.length - 1]?.trim() || 'Installing the speech packages. This is the longest step.'
  } else if (fraction !== null) {
    const parts = [`${formatBytes(status.bytesDone)} of ${formatBytes(status.bytesTotal)}`]
    if (status.bytesPerSecond > 0) parts.push(`${formatBytes(status.bytesPerSecond)}/s`)
    if (status.currentFile) parts.unshift(status.currentFile)
    line = parts.join(' · ')
  } else if (status.currentFile) {
    line = status.currentFile
  }
  return { steps, headline: status.message || 'Setting up voice.', line, fraction }
}
