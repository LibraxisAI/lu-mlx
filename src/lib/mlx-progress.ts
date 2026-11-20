// How a running MLX install is put into words. One place, because the Model
// Manager (a tile, the engine card) and Settings (the engine row) speak about
// the same slot, and two copies of this sentence had already drifted once:
// Settings joined percent, bytes and speed with a dash and a middot, the tiles
// with commas ("12%, 1 GB of 8 GB").

import { formatBytes } from './formatters'
import type { MlxInstallEntry } from '../stores/mlxInstallStore'

type Progress = Pick<MlxInstallEntry, 'progress' | 'total' | 'speed' | 'lastLog'>

/** Whole percent, or null while the installer reports no byte counts. */
export function mlxPercent(e: Progress): number | null {
  if (!e.total) return null
  return Math.min(100, Math.round((e.progress / e.total) * 100))
}

/** "1.2 GB of 8 GB, 3 MB/s", or the last log line while only the log talks. */
export function mlxProgressDetail(e: Progress): string {
  if (!e.total) return e.lastLog
  const speed = e.speed > 0 ? `, ${formatBytes(e.speed)}/s` : ''
  return `${formatBytes(e.progress)} of ${formatBytes(e.total)}${speed}`
}

/** The whole line: "12%, 1.2 GB of 8 GB, 3 MB/s". */
export function mlxProgressText(e: Progress): string {
  const pct = mlxPercent(e)
  if (pct === null) return e.lastLog
  return `${pct}%, ${mlxProgressDetail(e)}`
}
