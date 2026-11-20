/**
 * The short note "LU is controlling this computer" after the first yes in a
 * chat (ComputerNote). It stands above the input field of the window, and
 * on Windows and macOS that window becomes the small panel with the first
 * look at the screen. So the first look waits for as long as the note
 * stands: it is read, then the window gets out of the way. Nothing of the
 * task runs in that time, the wait sits before the session begins.
 *
 * One number for both. With a shorter wait the note was cut off by the
 * shrinking window after 1.5 s (measured at a real Windows window,
 * 10.10.2026).
 */
export const START_NOTE_MS = 2500

export function holdForStartNote(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, START_NOTE_MS)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

export interface Box { left: number; right: number; top: number; bottom: number }

/** The room the note keeps to what it steps aside for. */
export const NOTE_GAP_PX = 6

/**
 * How far the note has to move up so that it covers nothing of `keep`.
 *
 * The note hangs in the middle, directly above the input field. On the same
 * height stands the strip of the session, with the context meter on its
 * right. Where the note would lie on one of those, the note gives way and
 * goes above the strip. The strip never moves. `note` is the place of the
 * note when it is not lifted.
 */
export function noteLift(note: Box, keep: readonly Box[]): number {
  const hit = keep.filter((box) => box.right > box.left && box.bottom > box.top
    && box.left < note.right && box.right > note.left && box.top < note.bottom && box.bottom > note.top)
  if (hit.length === 0) return 0
  // Above everything that stands in the same columns, not only what it hit:
  // one step up must be enough.
  const columns = keep.filter((box) => box.right > box.left && box.left < note.right && box.right > note.left && box.top < note.bottom)
  const top = Math.min(...columns.map((box) => box.top))
  return Math.max(0, Math.ceil(note.bottom - top + NOTE_GAP_PX))
}
