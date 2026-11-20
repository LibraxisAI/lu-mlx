import { animate } from 'framer-motion'
import { PART_IDS, restOpacity, type PartId } from './glyph-geometry'
import { MOTIFS, type StatusKind } from './glyph-motifs'
import { hold, isStill, poseAt, toTransform, type Pose, type Track } from './glyph-pose'

/**
 * Plays a state on the parts of one glyph.
 *
 * Only `transform` (as one string) and `opacity` are ever animated. For those
 * two framer-motion hands the keyframes to the Web Animations API, so the loop
 * is the browser's to run: no JavaScript per frame, no React render per frame,
 * and the mark keeps moving while the page is busy rendering an answer.
 *
 * A change of state is two beats. First every part glides from wherever it is
 * to the new state's opening pose, then the loops start together. Stopping a
 * loop leaves each part where it was, which is what makes the glide start in
 * the right place.
 */

/** How long a part takes from its current pose to the next state's opening pose. Close to --motion-slow. */
export const GLIDE_SECONDS = 0.28
const GLIDE_EASE = [0.2, 0, 0, 1] as const

interface Stoppable {
  stop: () => void
}

const REST_TRACKS = new Map<PartId, Track>()
function restTrack(id: PartId): Track {
  let tr = REST_TRACKS.get(id)
  if (!tr) {
    tr = hold({ o: restOpacity(id) })
    REST_TRACKS.set(id, tr)
  }
  return tr
}

/** The path a part takes in a state: its own track, or its rest pose held. */
export function trackOf(kind: StatusKind, id: PartId): Track {
  return MOTIFS[kind].tracks[id] ?? restTrack(id)
}

/** The pose a state opens with. Parts are painted in it before anything moves. */
export function openingPose(kind: StatusKind, id: PartId): Pose {
  return trackOf(kind, id).p[0]
}

/** The one frame that stands for a state when nothing may move. */
export function standingPose(kind: StatusKind, id: PartId): Pose {
  return poseAt(trackOf(kind, id), MOTIFS[kind].still)
}

/** True where the Web Animations API exists. Without it the glyph shows its standing frame. */
export function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

function loop(el: HTMLElement, tr: Track, seconds: number, scale: number): Stoppable {
  const transforms = tr.p.map((p) => toTransform(p, scale))
  const opacities = tr.p.map((p) => p.o)
  const moves = transforms.some((t) => t !== transforms[0])
  const fades = opacities.some((o) => o !== opacities[0])
  return animate(
    el,
    { ...(moves ? { transform: transforms } : null), ...(fades ? { opacity: opacities } : null) },
    { duration: seconds, times: tr.t, ease: tr.e, repeat: Infinity },
  )
}

/**
 * Starts `kind` on the given parts and returns the function that stops it.
 * `glide` is false for the first state of a freshly painted glyph, whose parts
 * already stand in the opening pose.
 */
export function playMotif(
  parts: ReadonlyMap<PartId, HTMLElement>,
  kind: StatusKind,
  scale: number,
  glide: boolean,
): () => void {
  const motif = MOTIFS[kind]
  let live: Stoppable[] = []
  let stopped = false

  const startLoops = () => {
    if (stopped) return
    live = []
    for (const id of PART_IDS) {
      const el = parts.get(id)
      const tr = motif.tracks[id]
      if (el && tr && !isStill(tr)) live.push(loop(el, tr, motif.dur, scale))
    }
  }

  if (glide) {
    const arrivals: Promise<unknown>[] = []
    for (const id of PART_IDS) {
      const el = parts.get(id)
      if (!el) continue
      const first = openingPose(kind, id)
      const move = animate(
        el,
        { transform: toTransform(first, scale), opacity: first.o },
        { duration: GLIDE_SECONDS, ease: GLIDE_EASE },
      )
      live.push(move)
      arrivals.push(move.finished)
    }
    void Promise.all(arrivals).then(startLoops, () => undefined)
  } else {
    // Tell framer-motion where the resting parts stand, in the same five
    // function form every later pose uses. Otherwise their first glide would
    // start from the browser's matrix reading of the same pose.
    for (const id of PART_IDS) {
      const el = parts.get(id)
      const tr = motif.tracks[id]
      if (!el || (tr && !isStill(tr))) continue
      const first = openingPose(kind, id)
      animate(el, { transform: toTransform(first, scale), opacity: first.o }, { duration: 0 })
    }
    startLoops()
  }

  return () => {
    stopped = true
    for (const a of live) a.stop()
    live = []
  }
}
