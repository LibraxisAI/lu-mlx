/**
 * Standstill: steps on the screen that change nothing.
 *
 * Seen on the box (09.10.2026): a model called `screenshot` and
 * `focus_window` in turns a hundred times. Nothing moved, nobody was told,
 * and the run ended when its context was full. This file counts steps without
 * effect. After a few the model is told what does not work and what to try
 * instead; after a few more the task pauses and the user decides.
 *
 * A step is without effect when it did not run (an error), when it ran and
 * the picture after it is the very same picture, or when it repeats a step of
 * the last few and the picture differs by a detail at most (a caret that
 * blinks). A screen that really changed starts the count again.
 */

/** Steps without effect in a row before the model is told. */
export const STANDSTILL_TELL_AT = 3
/** Steps without effect in a row before the task pauses. */
export const STANDSTILL_PAUSE_AT = 6
/** How many of the last steps count as "just tried". */
const RECENT_STEPS = 8
/** Cells of the coarse picture that may be one level off and still be the same screen. */
const MAX_SOFT_CELLS = 4

export interface StandstillStep {
  /** The action, with what makes it this action: see `stepSignature`. */
  signature: string
  /** A look (screenshot, read_tree) does nothing by design. */
  look: boolean
  /** Why it did not run. Null when it ran. */
  error: string | null
  /** The fingerprint of the picture after the step (Rust: `capture::fingerprint`). Null when there was none. */
  picture: string | null
}

export type StandstillVerdict =
  | { kind: 'ok' }
  | { kind: 'tell'; count: number; message: string }
  | { kind: 'pause'; count: number; sentence: string }

type Change = 'none' | 'detail' | 'screen' | 'unknown'

function compare(before: string | null, after: string | null): Change {
  if (before === null || after === null) return 'unknown'
  if (before === after) return 'none'
  const [a, b] = [before.split(':')[0], after.split(':')[0]]
  if (a.length !== b.length) return 'screen'
  let soft = 0
  for (let i = 0; i < a.length; i++) {
    const off = Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16))
    if (off >= 2) return 'screen'
    if (off === 1) soft += 1
  }
  return soft > MAX_SOFT_CELLS ? 'screen' : 'detail'
}

const round = (value: unknown): string => (typeof value === 'number' ? String(Math.round(value / 20) * 20) : String(value ?? ''))

/** Two calls that aim at nearly the same spot with the same input are the same step. */
export function stepSignature(args: Record<string, unknown>): string {
  const parts = [String(args.action ?? '')]
  for (const key of ['x', 'y', 'to_x', 'to_y', 'toX', 'toY']) if (key in args) parts.push(`${key}=${round(args[key])}`)
  for (const key of ['text', 'keys', 'key', 'window_id', 'windowId', 'direction', 'amount', 'button']) if (key in args) parts.push(`${key}=${String(args[key])}`)
  return parts.join(' ')
}

function reasonOf(error: string): string {
  return error.replace(/^Error:\s*/, '').split('\n')[0].trim()
}

export class Standstill {
  private idle = 0
  private picture: string | null = null
  private recent: string[] = []
  private reason: string | null = null

  /**
   * The user answered a question or a pause, or a new task began: whatever
   * comes next is not a repeat. `picture` is what the screen looks like now,
   * when the step that ended this way took a look.
   */
  reset(picture: string | null = null): void {
    if (picture !== null) this.picture = picture
    this.idle = 0
    this.recent = []
    this.reason = null
  }

  /** How many steps in a row changed nothing. */
  get count(): number {
    return this.idle
  }

  note(step: StandstillStep): StandstillVerdict {
    const change = compare(this.picture, step.picture)
    if (step.picture !== null) this.picture = step.picture
    const tried = this.recent.includes(step.signature)
    this.recent.push(step.signature)
    if (this.recent.length > RECENT_STEPS) this.recent.shift()

    if (change === 'screen') {
      // Something big moved, by this step or by anything else.
      this.idle = step.error === null ? 0 : 1
      this.reason = step.error === null ? null : reasonOf(step.error)
      this.recent = [step.signature]
      return { kind: 'ok' }
    }
    if (step.error !== null) {
      this.idle += 1
      this.reason = reasonOf(step.error)
    } else if (step.look) {
      // Looking again is fine. It only counts while nothing else works either.
      if (this.idle > 0 && tried && change !== 'unknown') this.idle += 1
    } else if (change === 'none' || (change === 'detail' && tried)) {
      this.idle += 1
    } else if (change === 'detail') {
      this.idle = 0
      this.reason = null
    }
    // 'unknown' after an action that ran: no picture to judge by, so it neither counts nor clears.

    if (this.idle >= STANDSTILL_PAUSE_AT) {
      const count = this.idle
      const why = this.reason ? ` Last reason: ${this.reason}` : ''
      this.reset()
      return { kind: 'pause', count, sentence: `The last ${count} steps changed nothing on the screen.${why}` }
    }
    if (this.idle >= STANDSTILL_TELL_AT) {
      const why = this.reason ? ` Last reason: ${this.reason}` : ''
      return {
        kind: 'tell',
        count: this.idle,
        message:
          `Standstill: the last ${this.idle} steps changed nothing on the screen.${why} ` +
          'Do not repeat them. Try a different way: use read_tree and act on the control by its number ("element"), use the keyboard instead of the mouse, or bring another window to the front with focus_window. ' +
          `If nothing works, stop and tell the user what is in the way. LU pauses the task after ${STANDSTILL_PAUSE_AT} steps without effect.`,
      }
    }
    return { kind: 'ok' }
  }
}
