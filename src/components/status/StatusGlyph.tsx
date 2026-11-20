import { memo, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import { GRID, PARENT, PART_IDS, SHAPES, TOKEN_RADIUS, TOKEN_SIZE, boxOf, type PartId } from './glyph-geometry'
import { canAnimate, openingPose, playMotif, standingPose } from './glyph-engine'
import type { StatusKind } from './glyph-motifs'
import { toTransform, type Pose } from './glyph-pose'

interface Props {
  /** What the run is doing. The mark changes its behaviour, never its place or size. */
  kind: StatusKind
  /** Edge length in CSS pixels. The drawing is made for 20. */
  size?: number
  /**
   * The colour of the letters. `accent` is the status sign of the chat.
   * `edge` draws them in the colour of the frame (light on dark, dark on
   * light): for the window of computer control, where the sign is the logo.
   */
  tone?: 'accent' | 'edge'
  /** Layout only. The colour comes from `tone`. */
  className?: string
}

const CHILDREN = new Map<PartId | null, PartId[]>()
for (const id of PART_IDS) {
  const parent: PartId | null = id.startsWith('t') ? 'T' : (PARENT[id as keyof typeof PARENT] ?? null)
  CHILDREN.set(parent, [...(CHILDREN.get(parent) ?? []), id])
}

/**
 * The frame is drawn in the quiet grey of the status word (gray-400 on dark,
 * gray-700 on light, through the theme's own remap of text-gray-500), so it
 * reads on either surface and steps back behind the accent coloured letters.
 */
const FRAME_PARTS = new Set<PartId>(['c0', 'c1', 'c2', 'c3', 'gh'])
const FRAME_CLASS = 'text-gray-500'

const SVG_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%', overflow: 'visible' }

function Shape({ id }: { id: PartId }) {
  const b = boxOf(id)
  if (id.startsWith('t')) {
    return (
      <svg viewBox={`0 0 ${TOKEN_SIZE} ${TOKEN_SIZE}`} style={SVG_STYLE}>
        <rect width={TOKEN_SIZE} height={TOKEN_SIZE} rx={TOKEN_RADIUS} fill="currentColor" />
      </svg>
    )
  }
  const shape = SHAPES[id]
  if (!shape) return null
  return (
    <svg viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} style={SVG_STYLE}>
      {shape.kind === 'stroke' ? (
        // Square ends reach half a unit past the cut, so two corners overlap
        // instead of leaving a hairline where the app's zoom lands off the pixel grid.
        // The width is one grid unit of the mark's own drawing, not a pixel width from the icon ladder.
        <path d={shape.d} fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" />
      ) : (
        <path d={shape.d} fill="currentColor" />
      )}
    </svg>
  )
}

interface PartsProps {
  scale: number
  poseOf: (id: PartId) => Pose
  register?: (id: PartId, el: HTMLElement | null) => void
}

function Parts({ scale, poseOf, register }: PartsProps) {
  const render = (parent: PartId | null): ReactNode =>
    (CHILDREN.get(parent) ?? []).map((id) => {
      const b = boxOf(id)
      const origin = parent ? boxOf(parent) : { x: 0, y: 0 }
      const pose = poseOf(id)
      return (
        <span
          key={id}
          data-part={id}
          ref={register ? (el) => register(id, el) : undefined}
          style={{
            position: 'absolute',
            left: (b.x - origin.x) * scale,
            top: (b.y - origin.y) * scale,
            width: b.w * scale,
            height: b.h * scale,
            transform: toTransform(pose, scale),
            opacity: pose.o,
          }}
          className={FRAME_PARTS.has(id) ? FRAME_CLASS : undefined}
        >
          <Shape id={id} />
          {render(id)}
        </span>
      )
    })
  return <>{render(null)}</>
}

/** The mark, moving. Painted once in the first state's opening pose; from then on only the engine touches it. */
function MovingGlyph({ kind, scale }: { kind: StatusKind; scale: number }) {
  const parts = useRef(new Map<PartId, HTMLElement>())
  const painted = useRef(kind)
  const started = useRef(false)

  useEffect(() => {
    const stop = playMotif(parts.current, kind, scale, started.current)
    started.current = true
    return stop
  }, [kind, scale])

  return (
    <Parts
      scale={scale}
      // Always the first state's opening pose: React must never repaint a pose the engine has since moved.
      poseOf={(id) => openingPose(painted.current, id)}
      register={(id, el) => {
        if (el) parts.current.set(id, el)
        else parts.current.delete(id)
      }}
    />
  )
}

/**
 * The LU mark as a status sign: one small figure that behaves differently for
 * each thing a run can be doing. Decorative by itself (`aria-hidden`); the word
 * beside it carries the meaning for assistive technology.
 *
 * With `prefers-reduced-motion`, or where the browser cannot animate, it stands
 * still in the frame that says the most about the state.
 */
const TONE_CLASS = { accent: 'text-lu-accent-edge dark:text-lu-accent', edge: FRAME_CLASS } as const

export const StatusGlyph = memo(function StatusGlyph({ kind, size = GRID, tone = 'accent', className }: Props) {
  const reduced = useReducedMotion()
  const scale = size / GRID
  const moving = !reduced && canAnimate()
  return (
    <span
      aria-hidden="true"
      data-testid="status-glyph"
      data-kind={kind}
      data-motion={moving ? 'on' : 'off'}
      data-tone={tone}
      className={className ? `${TONE_CLASS[tone]} ${className}` : TONE_CLASS[tone]}
      style={{ position: 'relative', display: 'inline-block', flex: 'none', width: size, height: size, pointerEvents: 'none', contain: 'layout style' }}
    >
      {moving ? (
        <MovingGlyph key={scale} kind={kind} scale={scale} />
      ) : (
        <Parts scale={scale} poseOf={(id) => standingPose(kind, id)} />
      )}
    </span>
  )
})
