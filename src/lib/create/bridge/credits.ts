// What a classic (non Studio) run costs, for the price on the order card.
//
// The web reads its own price table. The desktop has
// none on purpose: prices come from the server's catalogue (/api/jobs/catalog,
// stores/cloudCatalogStore), so a price change reaches an installed app
// without a release. This answers the web's call from that catalogue.
import type { RenderKind, RenderOp } from '../../render/cloud-jobs'
import { STUDIO_MODELS, studioBaseCredits } from '../../render/studio-contract'
import { cloudModelById, defaultCloudModel, runCredits } from '../../../stores/cloudCatalogStore'

// A model the provider meters by the length of its input: the rule and the
// numbers are the server's (credits.length of the catalogue).
export { lengthPrice, lengthCredits } from '../../../stores/cloudCatalogStore'
import { useCloudAuthStore } from '../../../stores/cloudAuthStore'

/** The server's limits for a music track (the server's price table).
 *  Held to the web's numbers by web-parity.test.ts. */
export const MUSIC_SECONDS = { min: 5, max: 240, fallback: 60 }

export function mediaCredits(
  kind: RenderKind,
  model?: string,
  seconds?: number,
  op?: string,
  resolution?: string,
  withLora = false,
): number {
  if (model && STUDIO_MODELS[model] && (!op || op === 'studio')) return studioBaseCredits(model)
  const id = model ?? defaultCloudModel(kind)?.id ?? ''
  const length = op === 'music'
    ? Math.min(MUSIC_SECONDS.max, Math.max(MUSIC_SECONDS.min, seconds && seconds > 0 ? seconds : MUSIC_SECONDS.fallback))
    : seconds
  // A run with a trained character books the rate of the model's character
  // route, which replaces the plain rate.
  const lora = withLora ? cloudModelById(id)?.credits?.lora : undefined
  if (typeof lora === 'number') return lora
  // Without a price in the catalogue (offline start, a model the seed does not
  // price): the per-kind figure the server sends with the quota, as the Create
  // tab does. The card shows what was really booked once the run is done.
  const costs = useCloudAuthStore.getState().quota?.costs
  const fallback = costs ? costs[kind === 'video' ? 'video' : 'image'] : 0
  return runCredits(kind, (op ?? 'generate') as RenderOp, id, length, fallback, resolution)
}
