import { describe, expect, it } from 'vitest'
import { PART_IDS, centreOf, restOpacity, type PartId } from '../glyph-geometry'
import { MOTIFS, STATUS_KINDS, type StatusKind } from '../glyph-motifs'
import { trackOf } from '../glyph-engine'
import { hold, isStill, moveTo, poseAt, toTransform, track, turnAbout, type Pose } from '../glyph-pose'

/** Where the part's centre ends up on the grid, and how far it is turned in all. */
function placed(id: PartId, p: Pose) {
  const c = centreOf(id)
  const rad = (p.a * Math.PI) / 180
  return {
    x: c.x + p.x + Math.cos(rad) * p.ox - Math.sin(rad) * p.oy,
    y: c.y + p.y + Math.sin(rad) * p.ox + Math.cos(rad) * p.oy,
    turn: p.a + p.r,
  }
}

/** The frame, the echo ring and the tokens look the same after a quarter turn. */
const symmetry = (id: PartId) => (id === 'F' || id === 'gh' || id.startsWith('t') ? 90 : 360)
const sameAngle = (a: number, b: number, period: number) => {
  const d = (((a - b) % period) + period) % period
  return Math.min(d, period - d) < 1e-6
}

const everyTrack = (): Array<[StatusKind, PartId]> =>
  STATUS_KINDS.flatMap((kind) => (Object.keys(MOTIFS[kind].tracks) as PartId[]).map((id): [StatusKind, PartId] => [kind, id]))

describe('the status choreographies', () => {
  it('names only parts that exist', () => {
    for (const [, id] of everyTrack()) expect(PART_IDS).toContain(id)
  })

  it.each(everyTrack())('%s / %s runs from 0 to 1 in order, with one easing per step and no stray numbers', (kind, id) => {
    const tr = MOTIFS[kind].tracks[id]!
    expect(tr.t[0]).toBe(0)
    expect(tr.t[tr.t.length - 1]).toBe(1)
    for (let i = 1; i < tr.t.length; i++) expect(tr.t[i]).toBeGreaterThanOrEqual(tr.t[i - 1])
    expect(tr.p).toHaveLength(tr.t.length)
    expect(tr.e).toHaveLength(tr.t.length - 1)
    for (const pose of tr.p) for (const v of Object.values(pose)) expect(Number.isFinite(v)).toBe(true)
    for (const pose of tr.p) {
      expect(pose.o).toBeGreaterThanOrEqual(0)
      expect(pose.o).toBeLessThanOrEqual(1)
    }
  })

  it.each(everyTrack())('%s / %s closes its loop without a visible jump', (kind, id) => {
    const tr = MOTIFS[kind].tracks[id]!
    const first = tr.p[0]
    const last = tr.p[tr.p.length - 1]
    expect(last.o).toBeCloseTo(first.o, 6)
    if (first.o === 0) return // hidden at the seam, so it may be anywhere
    const a = placed(id, first)
    const b = placed(id, last)
    expect(b.x).toBeCloseTo(a.x, 6)
    expect(b.y).toBeCloseTo(a.y, 6)
    expect(last.sx).toBeCloseTo(first.sx, 6)
    expect(last.sy).toBeCloseTo(first.sy, 6)
    expect(sameAngle(a.turn, b.turn, symmetry(id))).toBe(true)
  })

  it('keeps the tokens inside the frame in the states that are meant to stay contained', () => {
    const contained: StatusKind[] = ['loading', 'thinking', 'preparing', 'reading', 'writing', 'running', 'creating']
    for (const kind of contained) {
      for (const id of PART_IDS.filter((p) => p.startsWith('t'))) {
        const tr = trackOf(kind, id)
        for (let step = 0; step <= 200; step++) {
          const pose = poseAt(tr, step / 200)
          if (pose.o < 0.05) continue
          const at = placed(id, pose)
          expect(at.x, `${kind} ${id} x`).toBeGreaterThan(1.5)
          expect(at.x, `${kind} ${id} x`).toBeLessThan(18.5)
          expect(at.y, `${kind} ${id} y`).toBeGreaterThan(1.5)
          expect(at.y, `${kind} ${id} y`).toBeLessThan(18.5)
        }
      }
    }
  })

  it('gives every state a loop length and a standing frame inside the loop', () => {
    for (const kind of STATUS_KINDS) {
      expect(MOTIFS[kind].dur).toBeGreaterThanOrEqual(1)
      expect(MOTIFS[kind].dur).toBeLessThanOrEqual(4)
      expect(MOTIFS[kind].still).toBeGreaterThanOrEqual(0)
      expect(MOTIFS[kind].still).toBeLessThanOrEqual(1)
    }
  })

  it('leaves a part that a state does not name at rest', () => {
    expect(isStill(trackOf('working', 'G'))).toBe(true)
    expect(trackOf('working', 'G').p[0].o).toBe(restOpacity('G'))
    expect(trackOf('working', 't3').p[0].o).toBe(0)
  })
})

describe('poses', () => {
  it('always writes the same five transform functions in the same order', () => {
    const shape = /^translate\([^)]*px, [^)]*px\) rotate\([^)]*deg\) translate\([^)]*px, [^)]*px\) rotate\([^)]*deg\) scale\([^)]*, [^)]*\)$/
    for (const [kind, id] of everyTrack()) for (const pose of MOTIFS[kind].tracks[id]!.p) expect(toTransform(pose, 1.15)).toMatch(shape)
    expect(toTransform(hold({}).p[0], 1)).toBe('translate(0px, 0px) rotate(0deg) translate(0px, 0px) rotate(0deg) scale(1, 1)')
  })

  it('scales lengths with the glyph and leaves angles and factors alone', () => {
    const pose = track({ x: 2, y: -1, a: 30, ox: 4, r: 15, sx: 0.5, sy: 2 }).p[0]
    expect(toTransform(pose, 2)).toBe('translate(4px, -2px) rotate(30deg) translate(8px, 0px) rotate(15deg) scale(0.5, 2)')
  })

  it('carries values from step to step and pads the track to the whole loop', () => {
    const tr = track({ o: 0 }, [0.2, { x: 3 }], [0.6, { o: 1 }, [0.2, 0, 0, 1]])
    expect(tr.t).toEqual([0, 0.2, 0.6, 1])
    expect(tr.p.map((p) => [p.x, p.o])).toEqual([[0, 0], [3, 0], [3, 1], [3, 1]])
    expect(tr.e).toEqual(['linear', [0.2, 0, 0, 1], 'linear'])
  })

  it('reads `s` as both scale axes unless one is given', () => {
    expect(track({ s: 0.5 }).p[0]).toMatchObject({ sx: 0.5, sy: 0.5 })
    expect(track({ s: 0.5, sy: 2 }).p[0]).toMatchObject({ sx: 0.5, sy: 2 })
  })

  it('blends between keyframes for the standing frame', () => {
    const tr = track({}, [0, { x: 0 }], [0.5, { x: 10 }], [1, { x: 0 }])
    expect(poseAt(tr, 0.25).x).toBeCloseTo(5)
    expect(poseAt(tr, 0.5).x).toBeCloseTo(10)
    expect(poseAt(tr, 2).x).toBeCloseTo(0)
  })

  it('moves a part so its centre lands on the asked point', () => {
    expect(placed('t0', track(moveTo('t0', 12, 3)).p[0])).toMatchObject({ x: 12, y: 3 })
  })

  it('turns a part about a pivot and can carry the pivot along', () => {
    // The L, turned to a prompt: its corner (5, 14) must land on (7.6, 10).
    const pose = track(turnAbout('GL', { x: 5, y: 14 }, -135, { x: 7.6, y: 10 })).p[0]
    const c = centreOf('GL')
    const rad = (pose.a * Math.PI) / 180
    const corner = { x: 5 - c.x + pose.ox, y: 14 - c.y + pose.oy }
    expect(c.x + pose.x + Math.cos(rad) * corner.x - Math.sin(rad) * corner.y).toBeCloseTo(7.6)
    expect(c.y + pose.y + Math.sin(rad) * corner.x + Math.cos(rad) * corner.y).toBeCloseTo(10)
  })
})
