import { boxOf, centreOf, type PartId } from './glyph-geometry'

/**
 * Where a part is at one moment: grid units, degrees, opacity.
 *
 * The transform is always the same five functions in the same order,
 *
 *   translate(x, y) rotate(a) translate(ox, oy) rotate(r) scale(sx, sy)
 *
 * so the browser blends two poses function by function instead of falling back
 * to a matrix, and a turn of more than half a circle stays the turn it was
 * written as. `a` with `ox`/`oy` is a swing around a point other than the
 * part's own centre, `r` is the part spinning on the spot.
 */
export interface Pose {
  x: number
  y: number
  a: number
  ox: number
  oy: number
  r: number
  sx: number
  sy: number
  o: number
}

/** A pose as written in a choreography: only what differs, and `s` for both scale axes at once. */
export type PoseInput = Partial<Pose> & { s?: number }

export type Ease = 'linear' | readonly [number, number, number, number]

/** One part's path through a loop. `e[i]` shapes the way from keyframe i to keyframe i + 1. */
export interface Track {
  t: number[]
  p: Pose[]
  e: Ease[]
}

/** A keyframe as written: when (0 to 1), what changes, and how the part gets there. */
export type Step = readonly [t: number, pose: PoseInput, ease?: Ease]

const REST: Pose = { x: 0, y: 0, a: 0, ox: 0, oy: 0, r: 0, sx: 1, sy: 1, o: 1 }

function merge(base: Pose, input: PoseInput): Pose {
  const { s, ...rest } = input
  const next = { ...base, ...rest }
  if (s !== undefined) {
    if (rest.sx === undefined) next.sx = s
    if (rest.sy === undefined) next.sy = s
  }
  return next
}

/**
 * Builds a track. Values carry over from one step to the next, so a step
 * names only what moves. A track always starts at 0 and ends at 1: a first
 * step later than 0 holds the base until then, a last step before 1 holds to
 * the end.
 */
export function track(base: PoseInput, ...steps: Step[]): Track {
  let cur = merge(REST, base)
  const t: number[] = []
  const p: Pose[] = []
  const arrive: Ease[] = []
  if (steps.length === 0 || steps[0][0] > 0) {
    t.push(0)
    p.push(cur)
    arrive.push('linear')
  }
  for (const [at, pose, ease] of steps) {
    cur = merge(cur, pose)
    t.push(at)
    p.push(cur)
    arrive.push(ease ?? 'linear')
  }
  if (t[t.length - 1] < 1) {
    t.push(1)
    p.push(cur)
    arrive.push('linear')
  }
  return { t, p, e: arrive.slice(1) }
}

/** A part that holds one pose for the whole state. */
export function hold(pose: PoseInput): Track {
  return track(pose)
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** The CSS transform of a pose at `scale` pixels per grid unit. */
export function toTransform(p: Pose, scale: number): string {
  return (
    `translate(${round(p.x * scale)}px, ${round(p.y * scale)}px) rotate(${round(p.a)}deg) ` +
    `translate(${round(p.ox * scale)}px, ${round(p.oy * scale)}px) rotate(${round(p.r)}deg) ` +
    `scale(${round(p.sx)}, ${round(p.sy)})`
  )
}

export function samePose(a: Pose, b: Pose): boolean {
  return (
    a.x === b.x && a.y === b.y && a.a === b.a && a.ox === b.ox && a.oy === b.oy &&
    a.r === b.r && a.sx === b.sx && a.sy === b.sy && a.o === b.o
  )
}

/** True when a part does not move in this state, so it needs no running animation. */
export function isStill(tr: Track): boolean {
  return tr.p.every((pose) => samePose(pose, tr.p[0]))
}

/** The pose at a share of the loop, blended in a straight line. Used for the standing frame, not for playback. */
export function poseAt(tr: Track, at: number): Pose {
  const f = Math.min(1, Math.max(0, at))
  let i = 0
  while (i < tr.t.length - 2 && tr.t[i + 1] <= f) i++
  const span = tr.t[i + 1] - tr.t[i]
  const u = span <= 0 ? 1 : Math.min(1, Math.max(0, (f - tr.t[i]) / span))
  const from = tr.p[i]
  const to = tr.p[i + 1]
  const mix = (k: keyof Pose) => from[k] + (to[k] - from[k]) * u
  return { x: mix('x'), y: mix('y'), a: mix('a'), ox: mix('ox'), oy: mix('oy'), r: mix('r'), sx: mix('sx'), sy: mix('sy'), o: mix('o') }
}

/** Carries the part's centre to an absolute point on the grid. */
export function moveTo(id: PartId, x: number, y: number): PoseInput {
  const c = centreOf(id)
  return { x: x - c.x, y: y - c.y }
}

/** Turns the part by `deg` around `pivot` and, if given, carries the pivot to `to`. */
export function turnAbout(id: PartId, pivot: { x: number; y: number }, deg: number, to = pivot): PoseInput {
  const c = centreOf(id)
  return { x: to.x - c.x, y: to.y - c.y, a: deg, ox: c.x - pivot.x, oy: c.y - pivot.y }
}

/** Puts the part on a circle around `centre`, `deg` clockwise from three o'clock. */
export function onRing(id: PartId, centre: { x: number; y: number }, radius: number, deg: number): PoseInput {
  const c = centreOf(id)
  return { x: centre.x - c.x, y: centre.y - c.y, a: deg, ox: radius, oy: 0 }
}

/** Scales the part's height while its lower edge stays where it is. */
export function fromFloor(id: PartId, sy: number): PoseInput {
  return { sy, y: ((1 - sy) * boxOf(id).h) / 2 }
}
