/**
 * When the downloads tray in the header opens and closes itself.
 *
 * The tray opens itself the moment a download starts, and closes itself again
 * when there is nothing left to show — but ONLY if it was the tray that opened
 * it. A tray the user opened by hand stays put. (Regression of 2026-07-26: an
 * auto-opened tray had no way back, so the panel hung over the app reading
 * "No active downloads" until the user happened to click somewhere else.)
 *
 * This used to live in two `useEffect`s inside DownloadBadge that wrote the
 * answer back into React state after every change of the download picture,
 * which React 19 flags as `set-state-in-effect` — a cascading render, landing a
 * paint later than it had to. The rule itself never depended on effects, so it
 * is a pure function here and the component applies it while rendering. Being
 * pure is also the only way it can be tested at all: the repo has no render
 * harness (vitest runs in `node`, there is no @testing-library).
 */

import { countLabel } from './formatters'

/** Is the tray open, and was it the tray or the user that opened it. */
export interface TrayState {
  open: boolean
  /** True only while the tray is showing itself unasked. */
  auto: boolean
}

/** The download picture in one glance. */
export interface DownloadPulse {
  /** How many downloads are running right now (paused/finished excluded). */
  active: number
  /** Whether there is ANY entry at all — running, paused, finished or failed. */
  any: boolean
}

/**
 * The tray after the download picture changed from `seen` to `now`.
 *
 * Returns the SAME object when nothing applies, so a caller can skip the state
 * write entirely.
 *
 * Two transitions, in the order the two old effects ran in:
 *
 *  1. The number of running downloads changed and something is running: a
 *     download started, so show the tray and remember that WE opened it.
 *     Keyed on the count changing, not on "> 0", so the tray does not
 *     re-assert itself on every unrelated re-render.
 *  2. The last entry went away and the tray is the one that opened itself:
 *     close it. Keyed on `any` (every entry, not just active ones), so a
 *     finished or failed row stays readable until it is cleared.
 */
export function trayAfterPulse(tray: TrayState, seen: DownloadPulse, now: DownloadPulse): TrayState {
  if (seen.active !== now.active && now.active > 0) return { open: true, auto: true }
  if (seen.any !== now.any && !now.any && tray.auto) return { open: false, auto: false }
  return tray
}

/** The tray as it starts out: shut, and not by anyone's decision. */
export const TRAY_CLOSED: TrayState = { open: false, auto: false }

/**
 * The pulse the component compares its FIRST render against.
 *
 * Zero on purpose: a download already running when the badge mounts has to
 * count as one that just started, which is what the mount pass of the old
 * auto-open effect did.
 */
export const NO_PULSE: DownloadPulse = { active: 0, any: false }

/** One row of the ComfyUI download list, as the tray reads it. */
interface TrayRow {
  status: string
}

/** The files of one bundle as the tray shows them: the rows that exist, and
 *  the files the user cancelled. */
export interface TrayBundle<R extends TrayRow> {
  name: string
  files: { id: string; d: R }[]
  /** Cancelled by the user and not started again. */
  cancelled: string[]
}

/**
 * Group the download rows by bundle and keep each bundle's cancelled files
 * with it.
 *
 * The box, 03.10.2026: after "Cancel all" on a bundle with two finished and
 * three running files, the two finished rows were all that was left of it, and
 * "every row is complete" turned the group into "Complete (2 files)" with a
 * green check. A cancelled file has no row, so the group has to be told about
 * it. A file that has a row again (started once more) is not cancelled.
 *
 * A bundle with nothing but cancelled files is listed too. It used not to be
 * ("there is nothing to show"), and that was the next thing the box found:
 * after "Cancel all" the last row was gone, the tray shut itself the same
 * moment and read "No active downloads" when opened again, without a word
 * about the cancel. The summary stays until the user closes it.
 */
export function trayBundles<R extends TrayRow>(
  rows: Record<string, R>,
  bundleMap: Record<string, string>,
  cancelled: string[],
): TrayBundle<R>[] {
  const groups = new Map<string, TrayBundle<R>>()
  for (const [id, d] of Object.entries(rows)) {
    const name = bundleMap[id] || id
    if (!groups.has(name)) groups.set(name, { name, files: [], cancelled: [] })
    groups.get(name)!.files.push({ id, d })
  }
  for (const id of cancelled) {
    if (rows[id]) continue
    const name = bundleMap[id] || id
    if (!groups.has(name)) groups.set(name, { name, files: [], cancelled: [] })
    groups.get(name)!.cancelled.push(id)
  }
  return [...groups.values()]
}

/** What the tray says about a bundle as a whole. `complete` is the only state
 *  that gets the green check. */
export function bundleVerdict(bundle: TrayBundle<TrayRow>): { state: 'complete' | 'partial' | 'running'; line: string } {
  const done = bundle.files.filter((f) => f.d.status === 'complete').length
  if (done < bundle.files.length) return { state: 'running', line: '' }
  if (bundle.cancelled.length === 0) return { state: 'complete', line: `Complete (${countLabel(done, 'file')})` }
  if (done === 0) return { state: 'partial', line: `Cancelled, ${countLabel(bundle.cancelled.length, 'file')} not downloaded` }
  const total = done + bundle.cancelled.length
  return { state: 'partial', line: `${done} of ${countLabel(total, 'file')} downloaded, ${bundle.cancelled.length} cancelled` }
}
