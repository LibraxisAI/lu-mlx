import { useEffect, useLayoutEffect, useState } from 'react'
import { ModalButton } from '../ui/ModalActions'
import { ToggleSwitch } from '../ui/ToggleSwitch'
import { MousePointerClick, X } from 'lucide-react'
import { isTauri } from '../../api/backend'
import { COMPUTER_PAUSED_EVENT, COMPUTER_STOPPED_EVENT, requestComputerAttention, setComputerSurface, watchComputer, type StopReason } from '../../api/computer'
import {
  computerControlBusy,
  noteComputerStopped,
  setComputerAutonomy,
  stopComputerControl,
} from '../../api/computer-use'
import { noteComputerPaused } from '../../lib/computer/pause'
import { wantedSurface } from '../../lib/computer/surface'
import { useComputerStore } from '../../stores/computerStore'
import { massstab } from '../../hooks/usePopoverPlatz'
import { lokaleMasse } from '../../lib/popover-placement'
import { TaskProgress } from './ComputerActivity'
import { ComputerQuestion } from './ComputerQuestion'
import { ComputerSurface } from './ComputerSurface'
import { BetaMark } from '../ui/BetaMark'

const hintCls = 't-micro leading-relaxed text-gray-500 dark:text-gray-400'

/** How long the bar stays after the last thing computer control did. */
export const BAR_LINGER_MS = 4000
/** How often the interface says again which surface it wants. Rust lets go after ten seconds of silence. */
export const SURFACE_RENEW_MS = 3000
/** How often an autonomous session is asked whether the user reached for the mouse. */
export const WATCH_MS = 300
/** The widest the bar gets (44rem), and its distance from the edges of the panel. */
const BAR_MAX_WIDTH = 704
const BAR_GUTTER = 8
/** Below the title row every view has at the top of the panel. */
const BAR_OFFSET_TOP = 44

/** Free space kept under the bar. */
const BAR_CLEARANCE = 8

/**
 * How far the bar reaches down from the top of the main panel, as a length
 * every view can read (`--computer-bar-clear` on the root element, only
 * while the bar is up). A view whose content can come up under the bar keeps
 * that much free; Voice does, for the question above its controls.
 */
function useBarReach(shown: boolean): (bar: HTMLDivElement | null) => void {
  const [bar, setBar] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!shown || !bar) return
    const root = document.documentElement
    const publish = () => root.style.setProperty('--computer-bar-clear', `${BAR_OFFSET_TOP + bar.offsetHeight + BAR_CLEARANCE}px`)
    publish()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(bar)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--computer-bar-clear')
    }
  }, [shown, bar])
  return setBar
}

/** Is computer control busy right now? The end of a chat run changes nothing in the store, so it is polled. */
function useBusy(session: boolean): boolean {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!session) return
    const check = () => setBusy(computerControlBusy())
    const first = setTimeout(check, 0)
    const poll = setInterval(check, 500)
    const unsubscribe = useComputerStore.subscribe(check)
    return () => {
      clearTimeout(first)
      clearInterval(poll)
      unsubscribe()
      setBusy(false)
    }
  }, [session])
  return session && busy
}

/**
 * The bar is up while computer control is busy and a few seconds longer. The
 * session behind it lives on for minutes, so the bar cannot simply follow
 * the session: it would sit over the window long after the work is done.
 */
function useBarShown(session: boolean): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!session) return
    let idleSince: number | null = null
    const check = () => {
      if (computerControlBusy()) {
        idleSince = null
        setShown(true)
        return
      }
      idleSince ??= Date.now()
      if (Date.now() - idleSince >= BAR_LINGER_MS) setShown(false)
    }
    const first = setTimeout(check, 0)
    // The end of a chat run changes nothing in the store, so it is polled.
    const poll = setInterval(check, 500)
    const unsubscribe = useComputerStore.subscribe(check)
    return () => {
      clearTimeout(first)
      clearInterval(poll)
      unsubscribe()
      setShown(false)
    }
  }, [session])
  return session && shown
}

interface PanelBox { left: number; top: number; width: number }

/**
 * Where the main panel of the window is. The bar is placed inside it, so it
 * never lies over the navigation in the header or over the sidebar, however
 * small the window is.
 */
function useMainPanel(active: boolean): PanelBox | null {
  const [box, setBox] = useState<PanelBox | null>(null)
  useEffect(() => {
    if (!active) return
    const measure = () => {
      const main = document.querySelector('main')
      // The app lies under a zoom, and `left` and `top` of the bar count in
      // its own pixels, not in those a measured box comes back in.
      const rect = main ? lokaleMasse(massstab(main)).kasten(main.getBoundingClientRect()) : null
      setBox((before) => {
        const width = rect ? rect.right - rect.left : 0
        if (!rect || width <= 0) return null
        const next = { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(width) }
        return before && before.left === next.left && before.top === next.top && before.width === next.width ? before : next
      })
    }
    const first = setTimeout(measure, 0)
    // The sidebar opens and closes without the window changing its size.
    const poll = setInterval(measure, 500)
    window.addEventListener('resize', measure)
    return () => {
      clearTimeout(first)
      clearInterval(poll)
      window.removeEventListener('resize', measure)
    }
  }, [active])
  return active ? box : null
}

/** Position of the bar: inside the main panel, clear of the navigation. */
export function barPlacement(panel: PanelBox | null): { className: string; style?: React.CSSProperties } {
  if (!panel) return { className: 'top-[5.5rem] left-1/2 -translate-x-1/2 max-w-[min(92%,44rem)]' }
  return {
    className: '-translate-x-1/2',
    style: {
      // Sized by its content: a fixed box with only `left` set would be
      // squeezed into the space to the right of that point.
      width: 'max-content',
      left: panel.left + panel.width / 2,
      top: panel.top + BAR_OFFSET_TOP,
      maxWidth: Math.max(0, Math.min(panel.width - 2 * BAR_GUTTER, BAR_MAX_WIDTH)),
    },
  }
}

/**
 * Keep the window in the shape the work calls for: the panel while computer
 * control is busy, and the ordinary window otherwise. Rust applies it
 * and answers with what the window is now; where the window does not
 * shrink, that answer is always "window".
 */
function useSurface(busy: boolean): void {
  const stopped = useComputerStore((s) => !!s.stopped)
  const asking = useComputerStore((s) => !!s.prompt)
  const paused = useComputerStore((s) => s.paused)
  const monitorId = useComputerStore((s) => s.monitorId)
  const wanted = wantedSurface({ busy, stopped, asking, paused })
  const { mode, active, focus } = wanted
  useEffect(() => {
    // Outside the app there is no window to shrink.
    if (!isTauri()) {
      if (useComputerStore.getState().shrinks === null) useComputerStore.getState().setShrinks(false)
      return
    }
    let gone = false
    let called = false
    const send = () => {
      // Asked each time: the user can change the setting of the system while LU works.
      const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      void setComputerSurface({ mode, active, focus, monitorId, still })
        .then((applied) => {
          if (gone) return
          if (applied.ok) {
            useComputerStore.getState().setSurface(applied.mode, applied.glass)
            // Asked for the panel and still a window: this system keeps the window, and the bar carries Stop.
            if (mode !== 'window') useComputerStore.getState().setShrinks(applied.mode !== 'window')
            if (applied.corner) useComputerStore.getState().setCorner(applied.corner)
          } else useComputerStore.getState().setSurface('window')
          // The window did not change shape, and the paused view is in it:
          // the user is looking at another app, so the window comes forward. Once.
          if (focus && !called && !(applied.ok && applied.mode !== 'window')) {
            called = true
            void requestComputerAttention().catch(() => undefined)
          }
        })
        .catch(() => { if (!gone) useComputerStore.getState().setSurface('window') })
    }
    send()
    // The lease: without these, Rust puts the window back by itself.
    const renew = active ? setInterval(send, SURFACE_RENEW_MS) : null
    return () => {
      gone = true
      if (renew) clearInterval(renew)
    }
  }, [mode, active, focus, monitorId])
}

/** Ask Rust for the user's hand while an autonomous session works and nothing else is on screen. */
function useHandWatch(busy: boolean): void {
  const autonomous = useComputerStore((s) => s.session?.autonomous === true)
  const stopped = useComputerStore((s) => !!s.stopped)
  const asking = useComputerStore((s) => !!s.prompt)
  const paused = useComputerStore((s) => s.paused)
  const watching = busy && autonomous && !stopped && !asking && !paused
  useEffect(() => {
    if (!watching || !isTauri()) return
    const poll = setInterval(() => {
      void watchComputer().then((seen) => { if (seen.ok && seen.paused) noteComputerPaused() }).catch(() => undefined)
    }, WATCH_MS)
    return () => clearInterval(poll)
  }, [watching])
}

/**
 * Everything computer control shows the user, mounted once for the whole
 * app.
 *
 * While it works, LU is not a window to work in: it is the small panel in
 * the corner of the display (ComputerSurface). Where the
 * window does not shrink, a bar in the main panel says that LU is
 * controlling the computer and carries Stop.
 *
 * A question never stands at the top of the window any more. It stands
 * above the input field of the view the user is in (ComputerQuestionSlot),
 * and when that view has none, above the bottom edge of the window.
 */
export function ComputerControlHost() {
  const session = useComputerStore((s) => s.session)
  const stopped = useComputerStore((s) => s.stopped)
  const prompt = useComputerStore((s) => s.prompt)
  const notice = useComputerStore((s) => s.notice)
  const currentApp = useComputerStore((s) => s.currentApp)
  const autonomous = useComputerStore((s) => s.autonomous)
  const stopShortcut = useComputerStore((s) => s.stopShortcut)
  const pauseShortcut = useComputerStore((s) => s.pauseShortcut)
  const task = useComputerStore((s) => s.task)
  const surface = useComputerStore((s) => s.surface)
  const noSlot = useComputerStore((s) => s.questionSlots.length === 0)
  const setNotice = useComputerStore((s) => s.setNotice)

  // The shortcuts and the user's hand reach the engine in Rust. This is how
  // the interface hears about a stop and about a pause.
  useEffect(() => {
    if (!isTauri()) return
    const offs: (() => void)[] = []
    let gone = false
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const stop = await listen<{ reason?: StopReason }>(COMPUTER_STOPPED_EVENT, (event) => {
        noteComputerStopped(event.payload?.reason ?? 'user')
      })
      const pause = await listen(COMPUTER_PAUSED_EVENT, () => noteComputerPaused())
      if (gone) {
        stop()
        pause()
      } else offs.push(stop, pause)
    })()
    return () => {
      gone = true
      for (const off of offs) off()
    }
  }, [])

  const busy = useBusy(!!session)
  useSurface(busy)
  useHandWatch(busy)
  const lingering = useBarShown(!!session)
  // The bar is for a system whose window stays a window while LU works: it
  // carries Stop there. Where the window becomes the panel, the panel does.
  // A stop is told by the note above the input field (ComputerNote), everywhere.
  const keepsWindow = useComputerStore((s) => s.shrinks === false)
  const showBar = surface === 'window' && keepsWindow && !stopped && lingering
  const panel = useMainPanel(showBar)
  const placement = barPlacement(panel)
  const barRef = useBarReach(showBar)

  return (
    <>
      <ComputerSurface />

      {showBar && (
        <div
          ref={barRef}
          data-testid="computer-control-bar"
          role="status"
          // Above every dialog (z-50) and not made inert by one (ui/Modal.tsx):
          // Stop must stay in reach whatever else is open.
          data-lu-above-dialogs
          className={`fixed ${placement.className} z-[60] rounded-lg lu-elevated px-3 py-2`}
          style={placement.style}
        >
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            <MousePointerClick size={13} className="text-gray-500 shrink-0" />
            <p className="t-body text-gray-800 dark:text-gray-200 min-w-0 truncate">
              LU is controlling this computer{currentApp ? <span className="text-gray-500 dark:text-gray-400"> in {currentApp}</span> : null}
            </p>
            <BetaMark feature="computer-control" className="shrink-0" />
            <ToggleSwitch
              enabled={autonomous}
              onChange={(next) => void setComputerAutonomy(next)}
              label="Autonomous"
            />
            <ModalButton className="shrink-0" data-testid="computer-stop" onClick={() => void stopComputerControl()}>
              Stop{stopShortcut ? <span className="font-normal text-gray-500 dark:text-gray-400"> {stopShortcut}</span> : null}
            </ModalButton>
          </div>
          {!prompt && (
            <p className={`${hintCls} mt-1`}>
              {autonomous
                ? 'Autonomous for this session: LU asks only before sending, buying, deleting or changing permissions.'
                : 'Supervised: you confirm every action.'}
              {stopShortcut ? ` Press ${stopShortcut} anywhere to stop` : ' Use Stop to end it'}
              {stopShortcut && pauseShortcut ? `, ${pauseShortcut} to pause.` : '.'}
            </p>
          )}
          {task && (
            <div className="mt-1.5 pt-1.5 border-t border-gray-200 dark:border-white/10">
              <TaskProgress task={task} />
            </div>
          )}
          {notice && (
            <p className={`${hintCls} mt-1 flex items-start gap-2`} data-testid="computer-notice">
              <span className="min-w-0">{notice}</span>
              <button aria-label="Dismiss note" className="shrink-0 text-gray-400 hover:text-gray-700 dark:hover:text-white" onClick={() => setNotice(null)}>
                <X size={12} />
              </button>
            </p>
          )}
        </div>
      )}

      {/* The view the user is in has no input field to put the question
          above (Settings, Models): it stands above the bottom edge instead. */}
      {prompt && surface === 'window' && noSlot && (
        <div className="fixed z-[60] bottom-4 left-1/2 -translate-x-1/2 w-[min(92%,34rem)]" data-lu-above-dialogs data-testid="computer-question-fallback">
          <ComputerQuestion prompt={prompt} />
        </div>
      )}
    </>
  )
}
