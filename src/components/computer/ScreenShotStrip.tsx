import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { EyeOff } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { useScreenShotStore } from '../../lib/computer/screen-shots'
import type { ScreenShot } from '../../lib/computer/screen-shots'

interface Props {
  /** The tool call whose looks at the screen are shown. */
  callId: string
  className?: string
}

/**
 * What LU saw during one call of computer control: a small picture per look,
 * in order. A click opens it large. A look that was withheld because a
 * password field had the focus shows a line instead of a picture.
 *
 * The pictures exist for this session only (lib/computer/screen-shots.ts).
 * After a restart the card stands without them.
 */
export function ScreenShotStrip({ callId, className = '' }: Props) {
  const all = useScreenShotStore((s) => s.shots)
  const shots = useMemo(() => all.filter((shot) => shot.callId === callId), [all, callId])
  const [opened, setOpened] = useState<ScreenShot | null>(null)
  // The last one stays while the popup fades out.
  const [shown, setShown] = useState<ScreenShot | null>(null)
  if (opened && opened !== shown) setShown(opened)
  if (shots.length === 0) return null

  return (
    <>
      <ul className={`flex items-stretch gap-1.5 overflow-x-auto scrollbar-thin ${className}`} aria-label="Screenshots" data-testid="screen-shots">
        {shots.map((shot) => (
          <li key={shot.id} className="shrink-0">
            {shot.url ? (
              <button
                type="button"
                onClick={() => setOpened(shot)}
                title={shot.caption}
                aria-label={`Open screenshot: ${shot.caption}`}
                className="block h-12 overflow-hidden rounded border border-gray-200 dark:border-white/10 bg-black/5 dark:bg-black/30 hover:border-gray-400 dark:hover:border-white/30 transition-colors"
              >
                <img src={shot.url} alt="" className="h-full w-auto" draggable={false} />
              </button>
            ) : (
              <p
                data-testid="screen-shot-withheld"
                className="flex h-12 max-w-[15rem] items-center gap-1.5 rounded border border-dashed border-gray-300 dark:border-white/15 px-2 t-micro leading-snug text-gray-500 dark:text-gray-400"
              >
                <EyeOff size={11} className="shrink-0" aria-hidden="true" />
                {shot.caption}
              </p>
            )}
          </li>
        ))}
      </ul>
      {/* Out of the chat: a message of the list is its own box for layout and
          paint (content-visibility), so a popup inside it was cut off at the
          edge of the chat column and lay under the sidebar. */}
      {createPortal(
        <Modal open={opened !== null} onClose={() => setOpened(null)} title={shown?.caption ?? ''} maxWidth="max-w-3xl">
          {shown?.url && <img src={shown.url} alt="" className="mx-auto max-w-full rounded-md" />}
        </Modal>,
        document.body,
      )}
    </>
  )
}
