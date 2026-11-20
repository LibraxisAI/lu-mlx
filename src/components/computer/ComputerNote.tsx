import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useComputerStore } from '../../stores/computerStore'
import { dismissComputerStop } from '../../api/computer-use'
import { NOTE_GAP_PX, START_NOTE_MS, noteLift, type Box } from '../../lib/computer/start-note'
import { isMacOS } from '../../api/backend'

/** The stop shortcut as Rust registers it (commands/computer.rs). */
const stopShortcut = () => (isMacOS() ? 'Control+Option+Esc' : 'Ctrl+Alt+Esc')

/**
 * What computer control has to say while LU is its ordinary window: one
 * small line, in the middle, directly above the input field. The owner's
 * second exception to "nothing above the input field" (09.10.2026).
 *
 * Two kinds. "LU is controlling this computer" comes after the first yes in
 * a chat and takes itself down. A stop with its reason has to be seen: it
 * stays until the user writes on, sends a message or closes it. One note at
 * a time, the newer one wins. It takes no room of its own, so nothing moves
 * when it comes and goes.
 *
 * It covers nothing that stands there already. The strip of the session
 * (marked `data-computer-note-yields`) is on the same height, with the
 * context meter on its right. Where the note would lie on a part of it, the
 * note goes above the strip.
 */

/** The parts of the strips the note steps aside for. A bare spacer is room, not a part. */
function partsToKeepClear(): Box[] {
  const parts: Box[] = []
  for (const strip of document.querySelectorAll('[data-computer-note-yields]')) {
    for (const part of strip.children) {
      if (part.childElementCount === 0 && !part.textContent?.trim()) continue
      const { left, right, top, bottom } = part.getBoundingClientRect()
      parts.push({ left, right, top, bottom })
    }
  }
  return parts
}

export function ComputerNote() {
  const started = useComputerStore((s) => s.startNote)
  const stopped = useComputerStore((s) => (s.stopped && !s.stopped.dismissed ? s.stopped : null))
  const surface = useComputerStore((s) => s.surface)
  // Where the window stays a window, the bar with Stop says the same thing.
  const shrinks = useComputerStore((s) => s.shrinks !== false)
  useEffect(() => {
    if (started === null) return
    const left = Math.max(0, started + START_NOTE_MS - Date.now())
    const timer = setTimeout(() => {
      if (useComputerStore.getState().startNote === started) useComputerStore.getState().setStartNote(null)
    }, left)
    return () => clearTimeout(timer)
  }, [started])

  const note = useRef<HTMLDivElement>(null)
  const [lift, setLift] = useState(0)
  const start = started !== null && shrinks && !(stopped && (stopped.at ?? 0) >= started)
  const shown = surface === 'window' && (start || stopped !== null)
  const text = start ? 'start' : stopped?.message ?? ''
  useLayoutEffect(() => {
    if (!shown) return
    const place = () => {
      const el = note.current
      if (!el) return
      const now = el.getBoundingClientRect()
      // Where it would be without a lift: the lift only ever moves it up.
      const current = Number(el.dataset.lift ?? 0)
      const next = noteLift({ left: now.left, right: now.right, top: now.top + current, bottom: now.bottom + current }, partsToKeepClear())
      setLift(next)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [shown, text])

  if (!shown) return null
  return (
    <div className="relative h-0" data-testid="computer-note-place">
      <div
        ref={note}
        role="status"
        aria-live="polite"
        data-testid="computer-note"
        data-kind={start ? 'start' : 'stopped'}
        data-lift={lift}
        style={lift > 0 ? { bottom: `calc(100% + ${NOTE_GAP_PX + lift}px)` } : undefined}
        className={`lu-computer-note ${start ? 'lu-computer-note--passing' : ''}`}
      >
        {start ? (
          <>
            <span className="lu-computer-note-dot" aria-hidden="true" />
            <span className="truncate">LU is controlling this computer</span>
            <span className="shrink-0 text-gray-500 dark:text-gray-400">Stop: {stopShortcut()}</span>
          </>
        ) : (
          <>
            <span className="min-w-0">
              Computer control stopped. <span className="text-gray-500 dark:text-gray-400">{stopped!.message}</span>
            </span>
            <button type="button" aria-label="Dismiss" className="lu-computer-note-close" onClick={dismissComputerStop}>
              <X size={11} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
