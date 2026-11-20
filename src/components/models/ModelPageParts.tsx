// Two layout pieces every lane of the Models page uses, so that an empty lane
// and a section heading look the same on Chat, Image, Video and LoRAs. They
// lay out and nothing else: the glyph, the words and the action come from the
// lane, which knows what is missing and where its button leads.
import type { ReactNode } from 'react'

interface EmptyProps {
  /** The lane's glyph, at the one size empty states carry (28). */
  icon: ReactNode
  title: ReactNode
  /** One sentence: why it is empty or what fills it. */
  children?: ReactNode
  /** The single action that fixes it. This is the one place on the page
   *  where a `.lu-primary` stands, because the surface has exactly one. */
  action?: ReactNode
}

export function ModelEmptyState({ icon, title, children, action }: EmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-14 h-14 rounded-full flex items-center justify-center border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] text-gray-400 dark:text-gray-500">
        {icon}
      </div>
      <p className="mt-4 t-title text-gray-900 dark:text-white">{title}</p>
      {children && (
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-gray-500 dark:text-gray-400">{children}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** A line that only says the lane is still finding out. */
export function ModelQuietLine({ children }: { children: ReactNode }) {
  return <p className="py-16 px-6 text-center text-xs text-gray-500 dark:text-gray-400">{children}</p>
}

interface HeadProps {
  title: ReactNode
  icon?: ReactNode
  count?: number
  /** A few quiet words after the title, such as "picked for this Mac". */
  note?: ReactNode
  /** The heading level the lane needs here. */
  level?: 'h2' | 'h3'
}

/** The heading of a group of tiles or rows: label, count, and a rule that
 *  runs to the edge so the group reads as one block. */
export function SectionHead({ title, icon, count, note, level: Tag = 'h3' }: HeadProps) {
  return (
    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
      {icon}
      <Tag className="t-label text-gray-700 dark:text-gray-300">{title}</Tag>
      {count !== undefined && <span className="t-micro tabular-nums">{count}</span>}
      {note && <span className="t-micro">{note}</span>}
      <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.07]" />
    </div>
  )
}
