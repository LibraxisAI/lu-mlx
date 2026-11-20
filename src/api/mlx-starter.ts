// Which model the one-click setup of Create takes on this Mac.
//
// Apart from `api/mlx-install`, which runs the setup: the card that announces
// it reads the same plan, and has no use for the install slots and their
// store that module brings along.

import { getVideoStatus, listVideoModels, type VideoModel, type VideoStatus } from './mlx-video'
import { videoModelBringsItsEngine } from '../lib/video-engines'
import { fitsMacMemory, memoryNeedGb } from '../lib/mac-memory-fit'
import { getSharedMemoryGb } from '../lib/hardware'

/** What the setup needs to know of a catalogue entry to choose among them. */
interface StarterCandidate {
  sizeBytes: number
  installed: boolean
  unfiltered: boolean
  requiresImage?: boolean
  minRamGB?: number
  recommendedRamGB?: number
  starter?: boolean
}

/** What the setup takes, or why it takes nothing. `installed`: every model it
 *  could take is here already. `memory`: none of them sits in this Mac's
 *  memory, and `needGb` is the least any of them is recommended for. */
export type StarterChoice<T> =
  | { pick: T; reason?: undefined }
  | { pick: null; reason: 'installed' }
  | { pick: null; reason: 'memory'; needGb: number }

/**
 * The model the one-click setup of Create downloads.
 *
 * Mainstream only. The smallest video model of the whole catalogue is an
 * adult fine-tune (NSFW Wan 1.3B, 14.7 GB against the 18 GB of Wan 2.1), so
 * "smallest" alone gave a newcomer who pressed "Download & install" on the
 * Video tab a model from the Unfiltered side that nobody had chosen (persona
 * walk, 09.10.2026). The Unfiltered side stays a choice made in the Model
 * Manager. A model that cannot start without an image is left out as well:
 * the card stands on the text to video tab.
 *
 * Among those, only what sits in this Mac's memory, by the number the
 * catalogue names and the rule the tiles use. And of those the entry the
 * catalogue marks as the starter, else the smallest. "Smallest" alone made
 * Wan 2.1 T2V 1.3B the first video model of every Mac: half an hour for five
 * seconds on an M5 Pro, without sound, at 24.5 GB against the 16 its tile
 * promised (real run, 09.10.2026). A setup that fits nowhere says so and
 * downloads nothing. Memory that could not be read holds nothing back.
 */
export function starterChoice<T extends StarterCandidate>(models: T[], memoryGb: number | null = null): StarterChoice<T> {
  const missing = models.filter((m) => !m.installed && !m.unfiltered && !m.requiresImage)
  if (missing.length === 0) return { pick: null, reason: 'installed' }
  const need = (m: T) => memoryNeedGb({ minRamGB: m.minRamGB ?? 0, recommendedRamGB: m.recommendedRamGB })
  const fitting = missing.filter((m) => fitsMacMemory(need(m), memoryGb) !== false)
  if (fitting.length === 0) return { pick: null, reason: 'memory', needGb: Math.min(...missing.map(need)) }
  return { pick: fitting.find((m) => m.starter) ?? fitting.reduce((a, b) => (b.sizeBytes < a.sizeBytes ? b : a)) }
}

/** `starterChoice`, for a caller that only asks which model. */
export function starterPick<T extends StarterCandidate>(models: T[], memoryGb: number | null = null): T | null {
  return starterChoice(models, memoryGb).pick
}

/** What Create's video setup would do on this Mac, read once for the card
 *  that announces it and again by the run that does it. */
export interface MacVideoSetupPlan {
  choice: StarterChoice<VideoModel>
  /** This Mac's memory in GB, or null when it could not be read. */
  memoryGb: number | null
  /** Whether the engine the pick runs on is still to be set up. */
  engineMissing: boolean
}

export async function macVideoSetupPlan(status?: VideoStatus | null): Promise<MacVideoSetupPlan> {
  const [vs, models, memory] = await Promise.all([
    status === undefined ? getVideoStatus().catch(() => null) : status,
    listVideoModels(),
    getSharedMemoryGb().catch(() => 0),
  ])
  const memoryGb = memory > 0 ? memory : null
  const choice = starterChoice(models, memoryGb)
  const engineMissing = !!choice.pick && (videoModelBringsItsEngine(choice.pick.family) ? !vs?.ltx2MlxInstalled : !vs?.mlxInstalled)
  return { choice, memoryGb, engineMissing }
}
