/**
 * The LU mark, cut into parts.
 *
 * Measured on public/LU-monogram.svg (frame 336 wide, corner radius 77.6,
 * stroke 17; letter stems 38; U outer radius 72; the L foot ends on a circle
 * concentric with the U bowl, 8.9 further out) and redrawn on a 20 unit grid,
 * where the real proportions land on whole units: frame stroke 1, letter
 * stroke 2, letters 12 wide and 10 tall.
 *
 * Every part is one box. A pose moves a box with transform and opacity only,
 * so nothing here ever triggers layout while a run is going.
 */

export const GRID = 20

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type CornerId = 'c0' | 'c1' | 'c2' | 'c3'
export type StrokeId = 'lb' | 'lf' | 'ul' | 'ub' | 'ur'
export type GroupId = 'root' | 'F' | 'G' | 'GL' | 'GU' | 'T'
export type TokenId = `t${number}`
export type PartId = GroupId | CornerId | StrokeId | TokenId | 'gh'

/** Centres of the sixteen tokens the letters fall apart into. Each one sits on the ink of its letter. */
export const TOKEN_HOMES: ReadonlyArray<readonly [number, number]> = [
  // L: the bar from the top down to the corner, then the foot
  [5, 6], [5, 8], [5, 10], [5, 12], [5, 14], [7, 14],
  // U: left stem, the bowl along its centre line, right stem
  [9, 6], [9, 8], [9, 10],
  [9.23, 12.15], [10.85, 13.77], [13.15, 13.77], [14.77, 12.15],
  [15, 10], [15, 8], [15, 6],
]

export const TOKEN_COUNT = TOKEN_HOMES.length
export const TOKEN_SIZE = 2

export const tokenId = (i: number): TokenId => `t${i}`
export const TOKEN_IDS: readonly TokenId[] = TOKEN_HOMES.map((_, i) => tokenId(i))

const full: Box = { x: 0, y: 0, w: GRID, h: GRID }

/** Where each part sits when the mark is at rest, in grid units, measured from the glyph's top left. */
const FIXED_BOXES: Record<Exclude<PartId, TokenId>, Box> = {
  root: full,
  gh: full,
  F: full,
  c0: { x: 0, y: 0, w: 10, h: 10 },
  c1: { x: 10, y: 0, w: 10, h: 10 },
  c2: { x: 10, y: 10, w: 10, h: 10 },
  c3: { x: 0, y: 10, w: 10, h: 10 },
  G: full,
  GL: { x: 4, y: 5, w: 6, h: 10 },
  lb: { x: 4, y: 5, w: 2, h: 10 },
  lf: { x: 4, y: 13, w: 6, h: 2 },
  GU: { x: 8, y: 5, w: 8, h: 10 },
  // The stems reach 0.3 into the bowl so the join never shows a hairline at sizes off the grid.
  ul: { x: 8, y: 5, w: 2, h: 6.3 },
  ub: { x: 8, y: 11, w: 8, h: 4 },
  ur: { x: 14, y: 5, w: 2, h: 6.3 },
  T: full,
}

export function boxOf(id: PartId): Box {
  if (id in FIXED_BOXES) return FIXED_BOXES[id as Exclude<PartId, TokenId>]
  const [cx, cy] = TOKEN_HOMES[Number(id.slice(1))]
  return { x: cx - TOKEN_SIZE / 2, y: cy - TOKEN_SIZE / 2, w: TOKEN_SIZE, h: TOKEN_SIZE }
}

export function centreOf(id: PartId): { x: number; y: number } {
  const b = boxOf(id)
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/** The part a box is nested in. A child's transform rides on its parent's. */
export const PARENT: Partial<Record<Exclude<PartId, TokenId>, GroupId>> = {
  F: 'root', G: 'root', T: 'root',
  c0: 'F', c1: 'F', c2: 'F', c3: 'F',
  GL: 'G', GU: 'G',
  lb: 'GL', lf: 'GL',
  ul: 'GU', ub: 'GU', ur: 'GU',
}

/** Every part, parents before children. */
export const PART_IDS: readonly PartId[] = [
  'gh', 'root', 'F', 'c0', 'c1', 'c2', 'c3', 'G', 'GL', 'lb', 'lf', 'GU', 'ul', 'ub', 'ur', 'T', ...TOKEN_IDS,
]

/** Opacity of a part when no state says otherwise: the mark shows, tokens and the echo ring do not. */
export function restOpacity(id: PartId): number {
  return id === 'gh' || id.startsWith('t') ? 0 : 1
}

/**
 * The drawing of each visible part, in absolute grid units. `stroke` parts are
 * centre lines of the frame (width 1, square ends that meet on the grid),
 * `fill` parts are closed shapes.
 */
export const SHAPES: Partial<Record<PartId, { kind: 'stroke' | 'fill'; d: string }>> = {
  c0: { kind: 'stroke', d: 'M1 10V4.9A3.9 3.9 0 0 1 4.9 1H10' },
  c1: { kind: 'stroke', d: 'M10 1H15.1A3.9 3.9 0 0 1 19 4.9V10' },
  c2: { kind: 'stroke', d: 'M19 10V15.1A3.9 3.9 0 0 1 15.1 19H10' },
  c3: { kind: 'stroke', d: 'M10 19H4.9A3.9 3.9 0 0 1 1 15.1V10' },
  gh: { kind: 'stroke', d: 'M4.9 1H15.1A3.9 3.9 0 0 1 19 4.9V15.1A3.9 3.9 0 0 1 15.1 19H4.9A3.9 3.9 0 0 1 1 15.1V4.9A3.9 3.9 0 0 1 4.9 1Z' },
  lb: { kind: 'fill', d: 'M4 5H6V15H4Z' },
  // The foot ends on the circle around the bowl's centre (12, 11), radius 4.55.
  lf: { kind: 'fill', d: 'M4 13H7.91A4.55 4.55 0 0 0 9.83 15H4Z' },
  ul: { kind: 'fill', d: 'M8 5H10V11.3H8Z' },
  ub: { kind: 'fill', d: 'M8 11A4 4 0 0 0 16 11H14A2 2 0 0 1 10 11Z' },
  ur: { kind: 'fill', d: 'M14 5H16V11.3H14Z' },
}

/** Corner radius of a token, as a share of its side. The frame's own ratio, so a token reads as a small frame. */
export const TOKEN_RADIUS = 0.5
