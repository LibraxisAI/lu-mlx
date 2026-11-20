/**
 * When the small LU mark above the composer shows.
 *
 * The run status line stands at the end of the transcript. Whoever scrolls up
 * while the model works loses sight of it, and with it the one sign that the
 * app is alive. The mark then floats just above the composer until the line is
 * back in view or the run is over.
 */

export interface BeaconState {
  /** The run status line is mounted, so a run is going. */
  running: boolean
  /** The observer has reported at least once. Before that nothing is known, and nothing shows. */
  observed: boolean
  /** Any part of the status line is inside the visible transcript. */
  anchorInView: boolean
}

export function beaconShows({ running, observed, anchorInView }: BeaconState): boolean {
  return running && observed && !anchorInView
}

type ObserverCtor = typeof IntersectionObserver

/**
 * Reports whether `anchor` is visible. With no explicit root the browser clips
 * against every scrolling ancestor, so the same call works for the chat list
 * and for the Code transcript. Where the browser has no observer the callback
 * never fires and the mark stays away.
 */
export function watchAnchor(
  anchor: Element,
  onChange: (inView: boolean) => void,
  Observer: ObserverCtor | undefined = globalThis.IntersectionObserver,
): () => void {
  if (typeof Observer !== 'function') return () => {}
  const io = new Observer((entries) => {
    // Several entries can queue up between two frames; the last one is the truth.
    const last = entries[entries.length - 1]
    if (last) onChange(last.isIntersecting)
  })
  io.observe(anchor)
  return () => io.disconnect()
}

/** The nearest ancestor that scrolls vertically: the transcript the status line lives in. */
export function scrollParent(el: Element | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/** Back to the newest line. The transcript's own scroll listener picks the following up again. */
export function jumpToLatest(from: Element | null): void {
  const box = scrollParent(from)
  if (box) box.scrollTop = box.scrollHeight
}
