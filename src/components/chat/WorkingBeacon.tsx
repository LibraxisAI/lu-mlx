import { useEffect, useRef, useState } from 'react'
import { StatusGlyph } from '../status/StatusGlyph'
import type { StatusKind } from '../status/glyph-motifs'
import { beaconShows, jumpToLatest, watchAnchor } from './working-beacon'

interface Props {
  /** The run status line this mark stands in for while it is out of view. */
  anchor: HTMLElement | null
  /** What the run is doing, the same state the status line shows. */
  kind: StatusKind
}

/**
 * The LU mark, floating just above the composer while the run status line is
 * scrolled out of view. No word, no clock: it only says that the run is still
 * going. A click goes back to the newest line.
 *
 * It takes no room. The holder is a line of zero height that sticks to the
 * bottom edge of the transcript, and the mark hangs above it, so neither the
 * transcript nor the composer moves when it comes or goes.
 */
export function WorkingBeacon({ anchor, kind }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState<{ anchor: HTMLElement | null; inView: boolean | null }>({ anchor: null, inView: null })

  useEffect(() => {
    if (!anchor) return
    return watchAnchor(anchor, (inView) => setSeen({ anchor, inView }))
  }, [anchor])

  // A report about an earlier status line says nothing about this one.
  const inView = seen.anchor === anchor ? seen.inView : null
  const shows = beaconShows({ running: !!anchor, observed: inView !== null, anchorInView: inView === true })

  return (
    <div ref={holder} className="pointer-events-none sticky bottom-0 z-10 h-0" data-testid="working-beacon-holder">
      {shows && (
        <button
          type="button"
          data-testid="working-beacon"
          data-status={kind}
          aria-label="Jump to the latest message"
          onClick={() => jumpToLatest(holder.current)}
          className="lu-elevated pointer-events-auto absolute bottom-1 left-1/2 flex h-[var(--control-h-sm)] w-[var(--control-h-sm)] -translate-x-1/2 items-center justify-center rounded-full"
        >
          <StatusGlyph kind={kind} size={16} />
        </button>
      )}
    </div>
  )
}
