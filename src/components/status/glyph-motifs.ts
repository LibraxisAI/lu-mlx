import { TOKEN_COUNT, TOKEN_HOMES, tokenId, type PartId } from './glyph-geometry'
import { fromFloor, hold, moveTo, onRing, track, turnAbout, type Ease, type PoseInput, type Step, type Track } from './glyph-pose'

/**
 * What the mark does in each state.
 *
 * One vocabulary for all of them: the frame is the machine, the letters are
 * what runs inside it, and the tokens the letters fall apart into are the text
 * that moves through it. A state is a short loop over those three, and every
 * loop either keeps the letters whole or brings them back.
 */
export type StatusKind =
  | 'starting'
  | 'loading'
  | 'thinking'
  | 'responding'
  | 'working'
  | 'preparing'
  | 'tool'
  | 'reading'
  | 'writing'
  | 'running'
  | 'searching'
  | 'looking'
  | 'creating'
  | 'delegating'
  | 'approval'
  | 'compacting'
  | 'retrying'

export interface Motif {
  /** Seconds per loop. */
  dur: number
  /** Parts that leave their rest pose in this state. Anything not named sits at rest. */
  tracks: Partial<Record<PartId, Track>>
  /** The share of the loop that says the most as a single frame, shown when motion is off. */
  still: number
}

const CENTRE = { x: 10, y: 10 }

// The house curve (--motion-ease) and its relatives.
const OUT: Ease = [0.2, 0, 0, 1]
const INOUT: Ease = [0.6, 0, 0.4, 1]
const IN: Ease = [0.6, 0, 1, 0.55]
const BACK: Ease = [0.3, 1.5, 0.6, 1]

const home = (i: number) => ({ x: TOKEN_HOMES[i][0], y: TOKEN_HOMES[i][1] })
/** A token's track. Tokens are hidden at rest, so their base opacity is 0. */
const token = (...steps: Step[]) => track({ o: 0 }, ...steps)
const tokens = (make: (i: number) => Track | null): Partial<Record<PartId, Track>> => {
  const out: Partial<Record<PartId, Track>> = {}
  for (let i = 0; i < TOKEN_COUNT; i++) {
    const tr = make(i)
    if (tr) out[tokenId(i)] = tr
  }
  return out
}

// ── Between steps: a light travels round the frame ──────────────────────────
const chase = (corner: number): Track => {
  const at = (n: number): PoseInput => ({ o: n % 4 === corner ? 1 : 0.3 })
  return track({}, [0, at(0)], [0.25, at(1), INOUT], [0.5, at(2), INOUT], [0.75, at(3), INOUT], [1, at(4), INOUT])
}
const working: Motif = {
  dur: 1.6,
  still: 0,
  tracks: { c0: chase(0), c1: chase(1), c2: chase(2), c3: chase(3) },
}

// ── Request sent, nothing back yet: the frame opens and locks on ────────────
const lockOn = (dx: number, dy: number): Track =>
  track({}, [0, { x: 1.5 * dx, y: 1.5 * dy, o: 0.45 }], [0.36, { x: 0, y: 0, o: 1 }, BACK], [0.64, {}], [1, { x: 1.5 * dx, y: 1.5 * dy, o: 0.45 }, INOUT])
const starting: Motif = {
  dur: 1.5,
  still: 0,
  tracks: {
    c0: lockOn(-1, -1),
    c1: lockOn(1, -1),
    c2: lockOn(1, 1),
    c3: lockOn(-1, 1),
    G: track({}, [0, { o: 0.45, s: 0.9 }], [0.36, { o: 1, s: 1 }, OUT], [0.64, {}], [1, { o: 0.45, s: 0.9 }, INOUT]),
  },
}

// ── Model loading: the letters are stacked from tokens, bottom up ───────────
const STACK_ORDER = [4, 5, 3, 2, 1, 0, 10, 11, 9, 12, 8, 13, 7, 14, 6, 15]
const loading: Motif = {
  dur: 3.4,
  still: 0.42,
  tracks: {
    G: track({}, [0, { o: 0 }], [0.69, {}], [0.75, { o: 1, s: 1.06 }, OUT], [0.8, { s: 1 }, INOUT], [0.9, {}], [1, { o: 0 }, INOUT]),
    ...tokens((i) => {
      const start = 0.02 + STACK_ORDER.indexOf(i) * 0.0368
      const land = start + 0.0765
      return token(
        [0, { y: 3 - home(i).y }],
        [start, {}],
        [start + 0.012, { o: 1 }],
        [land, { y: 0 }, IN],
        [land + 0.02, { y: 0.25, sy: 0.75 }],
        [land + 0.05, { y: 0, sy: 1 }, OUT],
        [0.7, {}],
        [0.74, { o: 0 }],
      )
    }),
  },
}

// ── Thinking: the letters come apart, turn over inside the frame, re-form ───
// Every token keeps its bearing from the centre and only changes its distance,
// so the letters unwind into three rings instead of bursting. The rings turn at
// different speeds, which is what shears the word apart and winds it back.
const RINGS: Array<{ rho: number; turns: number; of: number[]; nudge?: Record<number, number> }> = [
  { rho: 6.1, turns: 1, of: [0, 2, 4, 11, 13, 15] },
  { rho: 3.7, turns: 2, of: [3, 6, 10, 14] },
  // The three inner tokens all sit left of centre; the nudge spreads them round the ring.
  { rho: 1.5, turns: 2, of: [7, 8, 9], nudge: { 7: 55, 9: -50 } },
]
const EASE_IN: Ease = [0.4, 0, 0.8, 0.6]
const EASE_OUT: Ease = [0.2, 0.4, 0.6, 1]
const thinking: Motif = {
  dur: 3.6,
  still: 0.45,
  // The loop opens with the coming apart and rests on the whole word at its end,
  // so a state that lasts two seconds still shows what it is.
  tracks: {
    G: track({}, [0, {}], [0.02, {}], [0.07, { o: 0, s: 0.94 }], [0.84, {}], [0.89, { o: 1, s: 1.06 }, OUT], [0.94, { s: 1 }, INOUT]),
    ...tokens((i) => {
      const ring = RINGS.find((r) => r.of.includes(i))
      const h = home(i)
      if (!ring) {
        // The three tokens no ring has room for shrink away and come back for the re-forming.
        return token(
          [0.02, {}],
          [0.05, { o: 1 }],
          [0.19, { x: 0.6 * (CENTRE.x - h.x), y: 0.6 * (CENTRE.y - h.y), s: 0.2, o: 0 }, OUT],
          [0.72, {}],
          [0.86, { x: 0, y: 0, s: 1, o: 1 }, INOUT],
          [0.89, { o: 0 }],
        )
      }
      // Home, written as a place on a circle: same spot, same upright token.
      const rho = Math.hypot(h.x - CENTRE.x, h.y - CENTRE.y)
      const theta = (Math.atan2(h.y - CENTRE.y, h.x - CENTRE.x) * 180) / Math.PI
      const sweep = 360 * ring.turns
      const nudge = ring.nudge?.[i] ?? 0
      return token(
        [0, { ...onRing(tokenId(i), CENTRE, rho, theta), r: -theta }],
        [0.02, {}],
        [0.05, { o: 1 }],
        [0.22, { a: theta + 0.14 * sweep + nudge, ox: ring.rho, s: 0.7 }, EASE_IN],
        [0.69, { a: theta + 0.86 * sweep + nudge }],
        [0.86, { a: theta + sweep, ox: rho, s: 1 }, EASE_OUT],
        [0.89, { o: 0 }],
      )
    }),
  },
}

// ── Answer streaming: the three stems move like a voice level ───────────────
const level = (id: 'lb' | 'ul' | 'ur', values: number[]): Track =>
  track({}, ...values.map((v, i): Step => [i / (values.length - 1), fromFloor(id, v), INOUT]))
const responding: Motif = {
  dur: 1.7,
  still: 0.31,
  tracks: {
    // Never below six tenths: the stems move enough to read as a level and the word stays a word.
    lb: level('lb', [1, 0.7, 1.12, 0.62, 0.95, 0.68, 1.18, 0.78, 1]),
    ul: level('ul', [1, 1.2, 0.6, 1.05, 0.66, 1.25, 0.6, 0.9, 1]),
    ur: level('ur', [1, 0.6, 1.1, 0.68, 1.28, 0.6, 1, 0.66, 1]),
  },
}

// ── Tool call being written: a payload row fills under the letters ──────────
const preparing: Motif = {
  dur: 1.8,
  still: 0.7,
  tracks: {
    G: hold({ y: -1.3 }),
    ...tokens((i) => {
      if (i > 5) return null
      const at = 0.06 + i * 0.11
      return token([0, { ...moveTo(tokenId(i), 5 + 2 * i, 17.1), sy: 0.55 }], [at, {}], [at + 0.04, { o: 1 }], [0.8, {}], [0.9, { o: 0 }])
    }),
  },
}

// ── A tool with no face of its own: the frame turns like a nut ──────────────
const tool: Motif = {
  dur: 1,
  still: 0,
  tracks: { F: track({}, [0, { r: 0 }], [0.55, { r: 90 }, INOUT]) },
}

// ── Reading: a line of tokens scans the letters ─────────────────────────────
const SCAN: Array<[token: number, x: number]> = [[0, 5], [5, 7], [6, 9], [10, 11], [11, 13], [15, 15]]
const reading: Motif = {
  dur: 1.9,
  still: 0.25,
  tracks: {
    G: hold({ o: 0.5 }),
    ...tokens((i) => {
      const col = SCAN.find(([t]) => t === i)
      if (!col) return null
      const h = home(i)
      return token([0, { ...moveTo(tokenId(i), col[1], 3.8), sx: 1.2, sy: 0.5, o: 1 }], [0.46, { y: 16.2 - h.y }, INOUT], [0.54, {}], [1, { y: 3.8 - h.y }, INOUT])
    }),
  },
}

// ── Writing: tokens are set into lines, a caret ahead of them ───────────────
const LINES: Array<[x: number, y: number]> = [
  [5, 6.5], [7, 6.5], [9, 6.5], [11, 6.5], [13, 6.5], [15, 6.5],
  [5, 10], [7, 10], [9, 10], [11, 10],
  [5, 13.5], [7, 13.5], [9, 13.5], [11, 13.5], [13, 13.5],
]
const typedAt = (n: number) => 0.05 + n * 0.045
const CARET = TOKEN_COUNT - 1
const caretSteps: Step[] = [[0, { ...moveTo(tokenId(CARET), 4.4, 6.5), sx: 0.5, sy: 1.3, o: 0 }], [0.03, { o: 1 }]]
LINES.forEach(([x, y], n) => {
  const to = moveTo(tokenId(CARET), x + 1.7, y)
  caretSteps.push([typedAt(n) + 0.02, to, OUT], [typedAt(n + 1), to])
})
caretSteps.push([0.84, {}], [0.92, { o: 0 }])
const writing: Motif = {
  dur: 2.6,
  still: 0.7,
  tracks: {
    G: hold({ o: 0 }),
    [tokenId(CARET)]: token(...caretSteps),
    ...tokens((i) => {
      if (i >= LINES.length) return null
      const [x, y] = LINES[i]
      return token([0, { ...moveTo(tokenId(i), x, y), sy: 0.6 }], [typedAt(i), {}], [typedAt(i) + 0.02, { o: 1 }], [0.84, {}], [0.92, { o: 0 }])
    }),
  },
}

// ── Shell: L turns into a prompt, U drops to a blinking cursor ──────────────
const cursor = (i: number, x: number): Track =>
  token([0, { ...moveTo(tokenId(i), x, 14), sx: 1.3, o: 1 }], [0.5, {}], [0.52, { o: 0 }], [0.98, {}], [1, { o: 1 }])
const running: Motif = {
  dur: 1.1,
  still: 0.25,
  tracks: {
    // The bar is cut to the foot's length so both arms of the prompt match.
    lb: hold(fromFloor('lb', 0.56)),
    GL: hold(turnAbout('GL', { x: 5, y: 14 }, -135, { x: 7.6, y: 10 })),
    GU: hold({ ...fromFloor('GU', 0.2), o: 0 }),
    t10: cursor(10, 11),
    t11: cursor(11, 13),
    t12: cursor(12, 15),
  },
}

// ── Web: a ring leaves the frame like a ping ────────────────────────────────
const searching: Motif = {
  dur: 2,
  still: 0.3,
  tracks: {
    gh: track({ o: 0 }, [0, { s: 1 }], [0.03, { o: 0.8 }], [0.62, { s: 1.5, o: 0 }, OUT]),
    G: track({}, [0, { s: 1 }], [0.09, { s: 1.1 }, OUT], [0.32, { s: 1 }, INOUT]),
  },
}

// ── Screenshot or image input: the frame closes in like a viewfinder ────────
const closeIn = (dx: number, dy: number): Track =>
  track({}, [0, { x: 0, y: 0 }], [0.2, { x: -2 * dx, y: -2 * dy }, OUT], [0.5, {}], [0.7, { x: 0, y: 0 }, OUT])
const looking: Motif = {
  dur: 2.2,
  still: 0.3,
  tracks: {
    c0: closeIn(-1, -1),
    c1: closeIn(1, -1),
    c2: closeIn(1, 1),
    c3: closeIn(-1, 1),
    G: track({}, [0, {}], [0.26, {}], [0.31, { o: 0.1, s: 0.92 }], [0.42, { o: 1, s: 1 }, OUT]),
  },
}

// ── Image or video being made: noise on a grid settles into the letters ─────
const noise = (i: number, step: number) => {
  const n = Math.sin(i * 12.9898 + step * 78.233) * 43758.5453
  return 0.12 + 0.88 * (n - Math.floor(n))
}
const creating: Motif = {
  dur: 3,
  still: 0.45,
  tracks: {
    G: track({}, [0, {}], [0.05, {}], [0.1, { o: 0 }], [0.77, {}], [0.83, { o: 1 }]),
    ...tokens((i) =>
      token(
        [0.06, { o: 1 }],
        [0.2, { ...moveTo(tokenId(i), 5.5 + 3 * (i % 4), 5.5 + 3 * Math.floor(i / 4)), o: noise(i, 1) }, OUT],
        [0.3, { o: noise(i, 2) }],
        [0.4, { o: noise(i, 3) }],
        [0.5, { o: noise(i, 4) }],
        [0.6, { o: noise(i, 5) }],
        [0.78, { x: 0, y: 0, o: 1 }, INOUT],
        [0.83, { o: 0 }],
      ),
    ),
  },
}

// ── Delegation: the mark steps back and hands tokens to a second frame ──────
const handOver = (i: number, at: number): Track =>
  token(
    [0, { ...moveTo(tokenId(i), 12, 12), s: 0.9 }],
    [at, {}],
    [at + 0.04, { o: 1 }],
    [at + 0.3, { ...moveTo(tokenId(i), 22.2, 22.2), s: 0.6 }, INOUT],
    [at + 0.34, { o: 0 }],
  )
const delegating: Motif = {
  dur: 2.4,
  still: 0.3,
  tracks: {
    root: hold({ s: 0.72, x: -2.8, y: -2.8 }),
    gh: track({ o: 0 }, [0, { s: 0.38, x: 6, y: 6, o: 1 }], [0.5, {}], [0.56, { s: 0.46 }, OUT], [0.7, { s: 0.38 }, INOUT]),
    t0: handOver(0, 0.06),
    t1: handOver(1, 0.2),
    t2: handOver(2, 0.34),
  },
}

// ── Waiting for the user: two short hops, then stillness ────────────────────
const approval: Motif = {
  dur: 2.8,
  still: 0,
  tracks: {
    root: track({}, [0, { y: 0 }], [0.07, { y: -2.6 }, OUT], [0.14, { y: 0 }, IN], [0.2, { y: -1.2 }, OUT], [0.26, { y: 0 }, IN]),
  },
}

// ── Context being summarised: the frame presses the letters flat, twice ─────
const press = (dir: number): Track =>
  track({}, [0, { y: 0 }], [0.16, { y: 2.4 * dir }, INOUT], [0.3, { y: 0 }, OUT], [0.46, { y: 3.4 * dir }, INOUT], [0.62, { y: 0 }, OUT])
const compacting: Motif = {
  dur: 2.4,
  still: 0.46,
  tracks: {
    c0: press(1),
    c1: press(1),
    c2: press(-1),
    c3: press(-1),
    G: track({}, [0, { sy: 1 }], [0.16, { sy: 0.62 }, INOUT], [0.3, { sy: 1 }, BACK], [0.46, { sy: 0.46 }, INOUT], [0.62, { sy: 1 }, BACK]),
  },
}

// ── Retry: the letters shake, the frame winds back half a turn ──────────────
const retrying: Motif = {
  dur: 1.8,
  still: 0.5,
  tracks: {
    G: track({}, [0, { x: 0 }], [0.05, { x: -1.3 }, OUT], [0.11, { x: 1.3 }, INOUT], [0.17, { x: -0.7 }, INOUT], [0.23, { x: 0 }, INOUT]),
    F: track({}, [0, { r: 0 }], [0.28, {}], [0.72, { r: -180 }, INOUT]),
  },
}

export const MOTIFS: Record<StatusKind, Motif> = {
  starting, loading, thinking, responding, working, preparing, tool, reading, writing,
  running, searching, looking, creating, delegating, approval, compacting, retrying,
}

export const STATUS_KINDS = Object.keys(MOTIFS) as StatusKind[]
