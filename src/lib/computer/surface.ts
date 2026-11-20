/**
 * Which shape LU's window has while computer control works, decided in one
 * place from what the store holds. No React, no Tauri.
 *
 *   panel   computer control is busy: the small window in the corner of the
 *           display. It shows what the model thinks and does, asks the
 *           questions and carries Pause and Stop, in every state
 *   pause   the paused view over the whole display (see PAUSE_LAYOUT)
 *   window  nothing runs, or this system does not shrink the window
 *
 * `active` is "computer control is busy". The glow at the edge of the
 * display follows it and nothing else, so there is no shape of the window in
 * which something runs without the glow, or the glow is up with nothing
 * running.
 *
 * The panel stands in a corner of the display. Rust decides which and moves
 * the window (surface.rs); here is only what the grip in its head asks for,
 * and where a page that is not the window draws the panel.
 */

import type { PanelCorner, SurfaceMode } from '../../api/computer'

/**
 * The size of the panel and its distance from the edges of the display, in
 * the units of the interface. Rust sizes the window to the same numbers
 * (surface.rs); a test holds the two together.
 */
export const PANEL_SIZE = { width: 380, height: 480 }
export const PANEL_MARGIN = 12

/**
 * How the paused view is shown: in the panel, which then stays where and as
 * large as it is, or over the whole display. This is the one switch between
 * the two; the view itself is the same component either way.
 */
export const PAUSE_LAYOUT: 'fullscreen' | 'panel' = 'panel'

/** Where the panel comes up unless the user chose another corner. */
export const HOME_CORNER: PanelCorner = 'top_right'
/** How far the grip has to be dragged before it counts as a direction. */
export const GRIP_DRAG_MIN = 24

const onTop = (corner: PanelCorner) => corner === 'top_right' || corner === 'top_left'
const onRight = (corner: PanelCorner) => corner === 'top_right' || corner === 'bottom_right'
const cornerAt = (top: boolean, right: boolean): PanelCorner => (top ? (right ? 'top_right' : 'top_left') : right ? 'bottom_right' : 'bottom_left')

/**
 * What the grip asks for when it is let go. Dragged toward a side, the panel
 * goes to the corner on that side: left or right, up or down, or both at
 * once. A plain press asks for no corner (null), and Rust then takes the
 * next one around the display. The same corner again asks for nothing.
 */
export function grippedCorner(from: PanelCorner, dx: number, dy: number): PanelCorner | null | 'stay' {
  const sideways = Math.abs(dx) >= GRIP_DRAG_MIN
  const upOrDown = Math.abs(dy) >= GRIP_DRAG_MIN
  if (!sideways && !upOrDown) return null
  const to = cornerAt(upOrDown ? dy < 0 : onTop(from), sideways ? dx > 0 : onRight(from))
  return to === from ? 'stay' : to
}

/**
 * The panel on a page that is larger than the window would be (a browser, a
 * test): its place as `left` and `top`, so a change of corner can be seen
 * as the slide it is in the app. `unit` turns a number of the interface into
 * a CSS length.
 */
export function panelPlace(corner: PanelCorner, unit: (n: number) => string): { left: string; top: string } {
  const far = (size: number) => `calc(100% - ${unit(size + PANEL_MARGIN)})`
  return {
    left: onRight(corner) ? far(PANEL_SIZE.width) : unit(PANEL_MARGIN),
    top: onTop(corner) ? unit(PANEL_MARGIN) : far(PANEL_SIZE.height),
  }
}

/**
 * The part of a screenshot the panel hides, as [left, top, right, bottom] on
 * the 0..1000 grid, in words for the model. Null when nothing of LU is in
 * the picture.
 */
export function coveredSentence(covered: readonly (readonly number[])[] | undefined): string | null {
  const areas = (covered ?? []).filter((area) => area.length === 4 && area.every((n) => Number.isFinite(n)))
  if (areas.length === 0) return null
  const [left, top, right, bottom] = [
    Math.min(...areas.map((a) => a[0])), Math.min(...areas.map((a) => a[1])),
    Math.max(...areas.map((a) => a[2])), Math.max(...areas.map((a) => a[3])),
  ]
  return `The black area from ${left}, ${top} to ${right}, ${bottom} is LU's own panel, and you cannot see what is under it. If you need something there, click where it should be: that click does not run, the panel moves to another corner, and you get a new picture.`
}

export interface SurfaceFacts {
  /** A call runs, a task runs, a question waits, or the run that used the screen is still going. */
  busy: boolean
  /** Stopped by the user. A stopped session shows nothing but its note. */
  stopped: boolean
  /** A question waits for the user. */
  asking: boolean
  /** The paused view is up. */
  paused: boolean
}

export interface SurfaceWanted {
  mode: SurfaceMode
  /** Computer control is busy: the glow is on, and Rust keeps the lease. */
  active: boolean
  /** The window takes the keyboard: only while paused, when the user types. */
  focus: boolean
}

export function wantedSurface(facts: SurfaceFacts, pauseLayout: 'fullscreen' | 'panel' = PAUSE_LAYOUT): SurfaceWanted {
  const active = !facts.stopped && (facts.busy || facts.paused || facts.asking)
  if (!active) return { mode: 'window', active: false, focus: false }
  if (facts.paused) return { mode: pauseLayout === 'fullscreen' ? 'pause' : 'panel', active, focus: true }
  return { mode: 'panel', active, focus: false }
}
