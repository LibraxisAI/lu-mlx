// The stage of a tool that works from a source image, laid out so that what
// belongs to the picture is on screen with it.
//
// The stage is as high as the window leaves it: 451 px in a 1440 × 900
// window. The source image took up to 52 % of the window height, the result
// up to 62 %, so the picture alone filled the stage and everything under it
// (the reference strip, "Change image", the hint) lay below the fold, behind
// a scroll that nothing announced (persona walk, 09.10.2026,
// Funde 14 and 15).
//
// Here the picture is given the height that is left. In a wide stage the
// controls stand beside it, so it keeps nearly the whole height; in a narrow
// one they stand under it and it gives up as much as they need. The stage
// still scrolls where even that does not fit.
//
// Every platform uses it (Stage.tsx, OutputView.tsx).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../ui/cn'

/** From this stage width on the controls stand beside the picture. */
export const FIT_SIDE_FROM = 660
/** The width of the column beside the picture. */
export const FIT_SIDE_WIDTH = 328
/** Padding of the stage, top and bottom together: p-5 beside, p-4 stacked. */
const FIT_PADDING = { beside: 40, stacked: 32 }
/** A picture is never made smaller than this. Below it the stage scrolls. */
export const FIT_MIN_PICTURE = 120

/**
 * The height the picture may take.
 *
 * `frame` is the stage, `under` what stays below the picture in its column,
 * `side` the controls. Beside the picture they cost it nothing.
 */
export function fitPictureHeight(m: { frame: number; under: number; side: number; beside: boolean }): number {
  const left = m.frame - (m.beside ? FIT_PADDING.beside : FIT_PADDING.stacked) - m.under - (m.beside ? 0 : m.side)
  return Math.max(FIT_MIN_PICTURE, Math.floor(left))
}

interface Props {
  /** The picture. It is handed the CSS `max-height` it may take, and puts it
   *  on its `<img>` or `<video>`. Undefined until the stage is measured. */
  picture: (maxHeight: string | undefined) => ReactNode
  /** What stays under the picture in its column (the facts of a result). */
  under?: ReactNode
  /** The controls: beside the picture in a wide stage, under it in a narrow one. */
  side?: ReactNode
  /** The cap the picture had before, as a share of the window height. */
  capVh: number
  onDragOver?: React.DragEventHandler<HTMLDivElement>
  onDrop?: React.DragEventHandler<HTMLDivElement>
}

export function FitStage({ picture, under, side, capVh, onDragOver, onDrop }: Props) {
  const frame = useRef<HTMLDivElement>(null)
  const underRef = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<{ height: number; beside: boolean } | null>(null)

  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const measure = () => {
      const beside = !!side && el.clientWidth >= FIT_SIDE_FROM
      const height = fitPictureHeight({
        frame: el.clientHeight,
        under: underRef.current?.offsetHeight ?? 0,
        side: sideRef.current?.offsetHeight ?? 0,
        beside,
      })
      setFit((was) => (was && was.height === height && was.beside === beside ? was : { height, beside }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    for (const part of [el, underRef.current, sideRef.current]) if (part) watch.observe(part)
    return () => watch.disconnect()
  }, [side])

  const beside = fit?.beside ?? false
  return (
    <div
      ref={frame}
      className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col"
      data-testid="fit-stage"
      data-layout={beside ? 'beside' : 'stacked'}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className={cn('m-auto flex max-w-full items-center', beside ? 'flex-row gap-6 p-5' : 'flex-col p-4')}>
        <div className="flex min-w-0 flex-col items-center">
          {picture(fit ? `min(${capVh}vh, ${fit.height}px)` : undefined)}
          {under && <div ref={underRef} className="flex max-w-full flex-col items-center">{under}</div>}
        </div>
        {side && (
          <div
            ref={sideRef}
            className={cn('flex flex-col items-center [&>*]:max-w-full', beside ? 'shrink-0' : 'max-w-full')}
            style={beside ? { width: FIT_SIDE_WIDTH } : undefined}
            data-testid="fit-stage-side"
          >
            {side}
          </div>
        )}
      </div>
    </div>
  )
}
