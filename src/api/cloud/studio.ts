// P3: the two Studio-only cloud routes. Same layer as every other cloud call
// (cloudFetch: CLOUD_BASE + bearer), never a bare fetch out of a component
// (Abschnitt 4 des Portplans).

import { cloudFetch, jsonOrError, CloudJobError } from './client'
import type { ModelRuntime } from '../../lib/render/runtime-format'

export interface StudioQuoteResult {
  credits: number
  seconds?: number
}

export interface StudioQuoteParams {
  op: 'studio'
  studio_options: Record<string, unknown>
  // Whichever staged-upload path fields the picked model's schema needs
  // (image_paths, source_path, mask_path, audio_path, audio2_path, video_path,
  // last_image_path, duration, shot_type, ...); the exact set is per-model,
  // studio-contract.ts is the vertrag, not this type.
  [field: string]: unknown
}

const OLDER_SERVER_MESSAGE =
  'This feature needs a newer LU Cloud server. Try again later.'

/** Thrown on a 409 from `/api/jobs/studio-quote` (`code: 'quote_changed'`):
 *  the price this call asked about is stale, and `credits` carries the
 *  server's fresh number, typed through instead of buried in `.message`. */
export class StudioQuoteChangedError extends CloudJobError {
  readonly credits: number
  readonly seconds?: number
  constructor(message: string, credits: number, seconds?: number) {
    super(message, 409, { code: 'quote_changed' })
    this.name = 'StudioQuoteChangedError'
    this.credits = credits
    this.seconds = seconds
  }
}

/**
 * POST /api/jobs/studio-quote: the provider-confirmed price for one Studio
 * run, asked before the run books. Never falls back to a client-side formula
 * on failure: `studio-contract.ts` can PREVIEW a number for the controls, but
 * only this call's number is what the server will actually charge, and
 * booking against a guessed one risks a 409 after the customer already
 * pressed start (Portplan Abschnitt 4/7, Risiko 1+2).
 *
 * Two failure shapes both mean "this server does not have Studio yet", and
 * both get the same honest, English text instead of a technical one:
 *  - a plain 404 (the route answered, CORS present, but no handler, a
 *    server that shipped P0's CORS fix without this route existing yet), and
 *  - a raw network/CORS failure (the route has no `withCors`/`OPTIONS` at
 *    all, the browser never lets the response reach this code; the
 *    documented pre-P0 state of both routes today). cloudFetch already turns
 *    that into its own CloudJobError(status 0, "Could not reach the LU
 *    Cloud server...") for every OTHER cloud call; here it is reworded once
 *    more, because "try again in a moment" reads as a blip and this is a
 *    version gap. Any other rejection (401 not signed in, 408 timeout, a
 *    deliberate abort) is not a version gap and keeps its own status intact.
 */
export async function studioQuote(
  model: string,
  prompt: string,
  params: StudioQuoteParams,
  /** Vorab-Preis vor dem Hochladen (02.10.2026): nur die ZAHL der Bilder, nie
   *  eine Adresse. Ein Server, der das Feld nicht kennt, ignoriert es; der
   *  Aufrufer sendet es darum nur an einen Server, der Stufen fuehrt (also
   *  neu genug ist), siehe useStudioPrice. */
  quoteImages?: number,
): Promise<StudioQuoteResult> {
  let res: Response
  try {
    res = await cloudFetch('/api/jobs/studio-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, params, ...(quoteImages ? { quote_images: quoteImages } : {}) }),
    })
  } catch (err) {
    if (err instanceof CloudJobError && err.status !== 0) throw err
    throw new CloudJobError(OLDER_SERVER_MESSAGE, 0, { cause: err })
  }
  if (res.status === 404) throw new CloudJobError(OLDER_SERVER_MESSAGE, 404)
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      credits?: number
      seconds?: number
    }
    throw new StudioQuoteChangedError(
      typeof body.error === 'string'
        ? body.error
        : 'The price has changed. Review the new quote before starting.',
      typeof body.credits === 'number' ? body.credits : 0,
      typeof body.seconds === 'number' ? body.seconds : undefined,
    )
  }
  // 400 (invalid request/options) and 429 (quote rate limit) keep the
  // server's own text verbatim: jsonOrError throws CloudJobError with
  // `body.error` unchanged, nothing to reword or translate here.
  return jsonOrError<StudioQuoteResult>(res)
}

/**
 * GET /api/jobs/runtime: measured render times per model, for the "about
 * 45 sec" hint next to the price. Unreachable (offline, an older server, or
 * the same pre-P0 CORS gap as studio-quote) means silence, not a guess:
 * `MIN_SAMPLES` in runtime-format.ts already says this app would rather say
 * nothing than make one up, so any failure here just yields an empty map.
 */
export async function modelRuntimes(): Promise<Record<string, ModelRuntime>> {
  try {
    const res = await cloudFetch('/api/jobs/runtime')
    const body = await jsonOrError<{ runtimes: Record<string, ModelRuntime> }>(res)
    return body.runtimes ?? {}
  } catch {
    return {}
  }
}
