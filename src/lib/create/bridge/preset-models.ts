// The web's lib/render/preset-models.ts, as the mirrored Create in chat files
// see it. Two names sit elsewhere on the desktop, and one answers differently.
import type { RenderKind, RenderOp } from '../../render/cloud-jobs'
import { mediaCredits } from './credits'

export * from '../../render/preset-models'
export { studioOnlyImageModels } from '../../../stores/cloudCatalogStore'

/** The price of a classic preset step, always a number: an order needs a
 *  price on every line. The desktop's own classicCredits answers null while
 *  the catalogue has no price; here that falls onto the per-kind figure
 *  (bridge/credits.ts). Same argument mapping as the web: a clip from
 *  frames and fps, a track from duration. */
export function classicCredits(
  kind: RenderKind,
  model: string,
  op: RenderOp,
  p: { frames?: number; fps?: number; duration?: number; target_resolution?: string },
): number {
  const seconds = kind === 'video'
    ? (typeof p.frames === 'number' && typeof p.fps === 'number' && p.fps > 0 ? p.frames / p.fps : undefined)
    : kind === 'audio' ? p.duration : undefined
  return mediaCredits(kind, model, seconds, op, p.target_resolution, false)
}
