import { formatElapsed } from '../../lib/format-elapsed'
import type { StatusKind } from './glyph-motifs'
import { StatusGlyph } from './StatusGlyph'

export interface StatusChipProps {
  /** Which behaviour the mark shows. */
  kind: StatusKind
  /** The status word, announced when it changes. English, short. */
  word: string
  /** A figure that grows while the word stands, such as the size of a call being written. Shown, not announced. */
  detail?: string
  /** Whole seconds to show as the clock. Hidden below one second and when absent. */
  seconds?: number | null
}

/**
 * State in, sign plus word plus clock out. The presentational half of the run
 * status: it knows nothing about chats, stores or timers, so any surface that
 * can name a state (chat, Code, voice) can show the same line.
 *
 * The mark has a fixed slot and the word a minimum width, so a change between
 * the common one word states leaves the clock where it was.
 */
export function StatusChip({ kind, word, detail, seconds }: StatusChipProps) {
  return (
    // No container: the mark is what sets the line apart from body text. The
    // transparent border keeps every part where it sat inside the old pill.
    <span className="inline-flex w-fit items-center gap-2 border border-transparent pl-1 pr-2.5 py-0.5">
      <StatusGlyph kind={kind} />
      {/* The font's capitals sit a good pixel above the middle of their line box; the small offsets put word and clock on the mark's centre line. */}
      <span className="lu-tool-shimmer t-control relative top-[1.5px] min-w-[4.3rem] whitespace-nowrap">{word}</span>
      {detail && (
        <span aria-hidden="true" className="lu-hud-num t-micro relative top-px text-gray-500 dark:text-gray-500">
          {detail}
        </span>
      )}
      {seconds != null && seconds >= 1 && (
        <span aria-hidden="true" className="lu-hud-num t-micro relative top-px text-gray-500 dark:text-gray-500">
          {formatElapsed(seconds)}
        </span>
      )}
    </span>
  )
}
