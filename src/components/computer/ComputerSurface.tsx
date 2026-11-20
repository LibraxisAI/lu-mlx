import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ModalButton } from '../ui/ModalActions'
import { BetaMark } from '../ui/BetaMark'
import { StatusGlyph } from '../status/StatusGlyph'
import { toolFace } from '../status/run-status'
import { moveComputerPanel } from '../../api/computer'
import { pauseComputerControl, stopComputerControl } from '../../api/computer-use'
import { answerComputerPause, MAX_PAUSE_NOTE_CHARS } from '../../lib/computer/pause'
import { PANEL_MARGIN, PANEL_SIZE, PAUSE_LAYOUT, grippedCorner, panelPlace } from '../../lib/computer/surface'
import { COMPUTER_TASK_TOOL_NAME } from '../../lib/computer/prompt'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { useComputerStore } from '../../stores/computerStore'
import { ComputerActivity, taskStepText } from './ComputerActivity'
import { ComputerQuestion } from './ComputerQuestion'
import type { StatusKind } from '../status/glyph-motifs'

const hintCls = 't-micro leading-relaxed text-gray-500 dark:text-gray-400'

/** The sign and the word for what LU is doing right now. */
function useNow(): { kind: StatusKind; word: string } {
  const task = useComputerStore((s) => s.task)
  const prompt = useComputerStore((s) => s.prompt)
  const paused = useComputerStore((s) => s.paused)
  if (paused) return { kind: 'approval', word: 'Paused' }
  if (prompt) return { kind: 'approval', word: 'Waiting for your answer' }
  const face = toolFace(COMPUTER_TASK_TOOL_NAME)
  return { kind: face.kind, word: task ? taskStepText(task) : face.word }
}

/** The line that names the two shortcuts, which work wherever the pointer is. */
function ShortcutHint() {
  const stop = useComputerStore((s) => s.stopShortcut)
  const pause = useComputerStore((s) => s.pauseShortcut)
  if (!stop && !pause) return null
  return (
    <p className={`${hintCls} lu-computer-keys shrink-0 px-3.5 py-2 truncate`} data-testid="computer-shortcuts">
      {pause ? <>Pause <kbd>{pause}</kbd></> : null}
      {pause && stop ? <span aria-hidden="true"> · </span> : null}
      {stop ? <>Stop <kbd>{stop}</kbd></> : null}
    </p>
  )
}

/**
 * The grip: a short bar at the top edge of the panel, in the same place
 * whatever the panel shows. A press sends the panel to the next corner of
 * the display, a drag toward a side to the corner on that side. The window
 * does not follow the pointer; it slides once the grip is let go. Rust moves
 * it and remembers the corner as the user's choice.
 */
function PanelGrip() {
  const corner = useComputerStore((s) => s.corner)
  const from = useRef<{ x: number; y: number } | null>(null)
  const dragged = useRef(false)
  const send = (dx: number, dy: number) => {
    const wanted = grippedCorner(corner, dx, dy)
    if (wanted === 'stay') return
    void moveComputerPanel(wanted)
      .then((applied) => { if (applied.ok && applied.corner) useComputerStore.getState().setCorner(applied.corner) })
      .catch(() => undefined)
  }
  return (
    <button
      type="button"
      className="lu-computer-grip"
      data-testid="computer-grip"
      data-corner={corner}
      aria-label="Move the panel to another corner"
      title="Move the panel: press for the next corner, or drag toward a corner"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        from.current = { x: event.clientX, y: event.clientY }
        dragged.current = false
        // The pointer leaves the small window on its way: the grip keeps it.
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* no capture: a press still works */ }
      }}
      onPointerUp={(event) => {
        const start = from.current
        from.current = null
        if (!start) return
        const [dx, dy] = [event.clientX - start.x, event.clientY - start.y]
        if (grippedCorner(corner, dx, dy) === null) return
        // A drag. The click that may follow it is not a press.
        dragged.current = true
        send(dx, dy)
      }}
      onPointerCancel={() => { from.current = null }}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false
          return
        }
        send(0, 0)
      }}
    />
  )
}

/** The head of the panel: what LU does right now, and Pause and Stop, in reach at any time. */
function PanelHead() {
  const now = useNow()
  const stop = useComputerStore((s) => s.stopShortcut)
  const pause = useComputerStore((s) => s.pauseShortcut)
  return (
    <div className="lu-computer-head shrink-0 flex items-center gap-1.5 pl-3 pr-2 py-1">
      <StatusGlyph tone="edge" kind={now.kind} size={20} className="shrink-0" />
      {/* One small line, level with the logo. A long step ends in an ellipsis and is whole in the tooltip and in the list below. */}
      <p className="lu-computer-word text-gray-900 dark:text-white truncate min-w-0 flex-1" title={now.word} data-testid="computer-now">{now.word}</p>
      <BetaMark feature="computer-control" className="shrink-0" />
      <ModalButton variant="quiet" className="shrink-0" data-testid="computer-pause-button" title={pause ?? undefined} aria-keyshortcuts={pause ?? undefined} onClick={() => void pauseComputerControl()}>
        Pause
      </ModalButton>
      <ModalButton className="shrink-0" data-testid="computer-stop" title={stop ?? undefined} aria-keyshortcuts={stop ?? undefined} onClick={() => void stopComputerControl()}>
        Stop
      </ModalButton>
    </div>
  )
}

/**
 * The panel: what LU's window is while computer control works. What the
 * model thinks, does and writes runs through the middle and stays at the
 * newest line. A question stands at the bottom, where the input field of the
 * paused view is. The panel keeps its size whatever it shows.
 */
function WorkPanel() {
  const prompt = useComputerStore((s) => s.prompt)
  const { ref, contentRef } = useAutoScroll(prompt?.id)
  return (
    <>
      <PanelHead />
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3.5 py-3">
        <div ref={contentRef}>
          <ComputerActivity />
        </div>
      </div>
      {prompt ? <ComputerQuestion key={prompt.id} prompt={prompt} inPanel className="shrink-0" /> : <ShortcutHint />}
    </>
  )
}

/**
 * The paused view: the user moved the mouse, pressed a key or pressed the
 * pause shortcut. The agent does nothing until one of the two buttons is
 * pressed. There is no timer. Escape takes over, which is the safe side.
 *
 * It shows what the model did so far and takes one line for the model, which
 * travels with "Let it continue".
 */
export function ComputerPauseView({ layout }: { layout: 'fullscreen' | 'panel' }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const asked = useComputerStore((s) => s.pauseAsked)
  const why = useComputerStore((s) => s.pauseWhy)
  const box = useRef<HTMLDivElement>(null)
  // The focus starts on "Take over". A key the user was just pressing in
  // another app must never land on "Let it continue".
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [])
  const answer = (go: boolean) => {
    if (busy) return
    setBusy(true)
    void answerComputerPause(go, note).finally(() => setBusy(false))
  }
  const panel = (
    <div
      ref={box}
      role="alertdialog"
      aria-modal="true"
      aria-label="LU has paused"
      data-testid="computer-pause"
      data-layout={layout}
      className={`flex flex-col gap-3 p-4 text-left ${layout === 'fullscreen' ? 'lu-dialog lu-computer-enter w-full max-w-lg max-h-[85%] rounded-2xl' : 'lu-computer-enter h-full w-full min-h-0'}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        answer(false)
      }}
    >
      <div className="shrink-0 flex items-start gap-2.5">
        <StatusGlyph tone="edge" kind="approval" size={20} className="shrink-0 mt-px" />
        <div className="min-w-0">
          <h2 className="t-title text-gray-900 dark:text-white">LU has paused</h2>
          <p className="t-body text-gray-600 mt-0.5">
            <span data-testid="computer-pause-why">{why ?? (asked ? 'You asked LU to wait.' : 'You moved the mouse or pressed a key.')}</span> LU does nothing until you choose.
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin rounded-lg border border-gray-200 dark:border-white/10 p-2.5">
        <ComputerActivity />
      </div>
      <form
        className="shrink-0 space-y-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          answer(true)
        }}
      >
        <input
          type="text"
          value={note}
          maxLength={MAX_PAUSE_NOTE_CHARS}
          onChange={(event) => setNote(event.target.value)}
          aria-label="Instruction for LU"
          placeholder="Add an instruction for LU (optional)"
          data-testid="computer-pause-note"
          className="w-full h-[var(--control-h-md)] rounded-lg bg-transparent border border-gray-200 dark:border-white/10 px-2.5 t-body text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-600"
        />
        <div className="lu-computer-answers">
          <ModalButton data-autofocus disabled={busy} onClick={() => answer(false)}>Take over</ModalButton>
          <ModalButton variant="primary" type="submit" disabled={busy}>Let it continue</ModalButton>
        </div>
        <p className={hintCls}>Escape takes over.</p>
      </form>
    </div>
  )
  if (layout === 'panel') return panel
  return <div className="lu-dialog-scrim h-full w-full flex items-center justify-center p-6">{panel}</div>
}

/**
 * LU while it works on the screen. In the app the window itself has the
 * size of the panel (Rust sizes it, see surface.rs), so the panel fills the
 * window. Anywhere else (a browser, a test) the panel is laid out on the
 * page at the size and the place the window would have.
 */
export function ComputerSurface() {
  const surface = useComputerStore((s) => s.surface)
  const glass = useComputerStore((s) => s.glass)
  const corner = useComputerStore((s) => s.corner)
  const paused = useComputerStore((s) => s.paused)
  const asking = useComputerStore((s) => !!s.prompt)
  // The page under it is not shown: in the app there is no room for it, and
  // on a see-through window it would shine through around the panel.
  useEffect(() => {
    document.documentElement.dataset.computerSurface = surface
    return () => { delete document.documentElement.dataset.computerSurface }
  }, [surface])
  // The window did not shrink (Linux, or Rust could not apply the shape).
  // A pause still has to be answered: the question covers the window.
  if (surface === 'window' && !paused) return null
  if (surface !== 'panel') {
    return createPortal(
      <div data-testid="computer-surface" data-surface="pause" className="fixed inset-0 z-[80]">
        <ComputerPauseView layout="fullscreen" />
      </div>,
      document.body,
    )
  }
  // The window is the panel in the app. A page that is larger is a browser:
  // there the panel gets the size and the place the window would have.
  const fills = typeof window !== 'undefined' && window.innerWidth <= PANEL_SIZE.width + 2 * PANEL_MARGIN
  const pausedHere = PAUSE_LAYOUT === 'panel' && paused
  // The page scales everything by --ui-scale; the window does not grow with
  // it. Divided out, the panel is as large on the page as the window is.
  const px = (n: number) => `calc(${n}px / var(--ui-scale, 1))`
  return createPortal(
    <div
      data-testid="computer-surface"
      data-surface="panel"
      data-waiting={pausedHere || asking ? '' : undefined}
      data-corner={corner}
      className={`lu-computer-surface fixed z-[80] ${fills ? 'inset-0' : 'lu-computer-surface--placed'}`}
      // In the app Rust moves the window from corner to corner. On a page the panel is moved here, the same way.
      style={fills ? undefined : { ...panelPlace(corner, px), width: px(PANEL_SIZE.width), height: px(PANEL_SIZE.height) }}
    >
      <div
        data-testid="computer-panel"
        // An opaque window has square corners of its own: only a see-through one is round.
        className={`lu-dialog lu-computer-panel relative h-full w-full flex flex-col overflow-hidden ${glass || !fills ? 'rounded-[18px]' : 'lu-computer-panel--flush'}`}
      >
        <PanelGrip />
        {pausedHere ? <ComputerPauseView layout="panel" /> : <WorkPanel />}
      </div>
    </div>,
    document.body,
  )
}
