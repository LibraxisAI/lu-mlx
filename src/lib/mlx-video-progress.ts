/**
 * Where a local video run on a Mac stands, read from what the engine prints.
 *
 * Both video engines print one line per denoising step, the way tqdm writes
 * it: `Diffusion:  72%|███████▏  | 36/50 [27:31<10:36, 45.45s/it]`. The step
 * count and the engine's own estimate of what is left are in it. Before this
 * the run only showed seconds counting up under a bar that stood at 95 % from
 * the first minute on, so a clip that needs forty minutes looked the same as
 * one that hangs.
 */

export interface VideoRunProgress {
  step: number
  of: number
  /** What the engine expects to still need, in seconds. Absent before the
   *  first step has been timed. */
  secondsLeft?: number
}

const STEP_LINE = /(\d+)\/(\d+)\s*\[([0-9:]+)<([0-9:?]+)/

function seconds(clock: string): number | undefined {
  if (clock.includes('?')) return undefined
  const parts = clock.split(':').map(Number)
  if (parts.some(Number.isNaN)) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0)
}

/** The newest step line in the log, or null when the run has not reached the
 *  steps yet (loading, encoding) or prints none. */
export function videoRunProgress(logs: readonly string[]): VideoRunProgress | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const found = STEP_LINE.exec(logs[i])
    if (!found) continue
    const step = Number(found[1])
    const of = Number(found[2])
    if (!of || step > of) continue
    return { step, of, secondsLeft: seconds(found[4]) }
  }
  return null
}

/** "about 11 min left", "under a minute left". */
export function timeLeftWords(secondsLeft: number): string {
  if (secondsLeft < 60) return 'under a minute left'
  return `about ${Math.round(secondsLeft / 60)} min left`
}

/** The line under the bar and how full the bar is. */
export function videoRunStatus(logs: readonly string[], elapsedSeconds: number): { percent: number; text: string } {
  const at = videoRunProgress(logs)
  if (!at) {
    // Before the first step (the models load, the prompt is encoded), or an
    // engine that prints no step lines: the clock is all there is, and the
    // bar does not pretend to know more.
    return { percent: Math.min(8, 2 + Math.floor(elapsedSeconds / 10)), text: `Generating the video... ${elapsedSeconds}s` }
  }
  const percent = Math.min(95, 8 + Math.round((at.step / at.of) * 87))
  const left = at.secondsLeft === undefined || at.step === 0 ? '' : `, ${timeLeftWords(at.secondsLeft)}`
  const tail = at.step >= at.of ? ', writing the clip' : left
  return { percent, text: `Step ${at.step}/${at.of}${tail}` }
}

/**
 * When a local video run is given up.
 *
 * It used to be sixty minutes flat: a guard against a run that pins the
 * machine for hours with nothing to show. A long clip on a slow model needs
 * more than that and was cut off while it was working. A run that prints its
 * steps is judged by them: it goes on as long as a new step arrives within
 * the stall limit. A run that prints none keeps the old hour. Nothing runs
 * past the ceiling.
 */
export const VIDEO_RUN_HOUR_MS = 60 * 60_000
export const VIDEO_RUN_STALL_MS = 20 * 60_000
export const VIDEO_RUN_CEILING_MS = 4 * 60 * 60_000

export function videoRunGivenUp(run: { elapsedMs: number; step: number | null; sinceStepChangeMs: number }): string | null {
  if (run.elapsedMs > VIDEO_RUN_CEILING_MS) return 'Generation stopped after 4 hours'
  if (run.step === null) return run.elapsedMs > VIDEO_RUN_HOUR_MS ? 'Generation timed out after 60 minutes' : null
  return run.sinceStepChangeMs > VIDEO_RUN_STALL_MS ? 'Generation stopped: no new step for 20 minutes' : null
}

/**
 * What Create says before a long local run starts, or null for a short one
 * and for a model nobody has timed.
 *
 * The time comes from real runs on one Mac, so the sentence names that Mac
 * and does not promise the number for another.
 */
export const LONG_VIDEO_RUN_SECONDS = 10 * 60

export function longVideoRunLine(model: string, clipSeconds: number, measuredRunSecondsPerClipSecond: number | undefined): string | null {
  if (!measuredRunSecondsPerClipSecond || clipSeconds <= 0) return null
  const run = clipSeconds * measuredRunSecondsPerClipSecond
  if (run < LONG_VIDEO_RUN_SECONDS) return null
  const minutes = Math.round(run / 60)
  const length = `${Math.round(clipSeconds * 10) / 10} seconds`
  return `A clip of ${length} with ${model} takes about ${minutes} minutes on an M5 Pro with 48 GB, and longer on a smaller Mac. `
    + 'The run shows its step and the time left, and a shorter clip is done sooner.'
}
