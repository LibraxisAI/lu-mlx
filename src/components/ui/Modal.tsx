import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react'
import {
  FOCUSABLE_SELECTOR,
  backgroundNodesToHide,
  closeDialog,
  isFocusable,
  isTopDialog,
  nextFocusIndex,
  openDialog,
  pickInitialFocusIndex,
} from './dialog-a11y'
import { SPRING_PANEL } from './motion'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  /** A small mark right of the visible title (the Beta mark). It stands
   *  outside the heading, so the dialog keeps its plain name. */
  titleMark?: ReactNode
  children: ReactNode
  /** Hide the default title/X header so the dialog can render its own
   *  centered hero layout (a floating close button is still provided). */
  hideHeader?: boolean
  /** Tailwind max-width of the panel. Default `max-w-lg`. */
  maxWidth?: string
  /** Panel corner radius (default `rounded-2xl`). Override for a more angular look. */
  panelRadius?: string
  /** Panel padding (default `p-6`). Override for a tighter dialog. */
  panelPad?: string
  /** Name for screen readers. Needed when there is no visible title
   *  (`title=""` or `hideHeader`); given next to a visible title, it wins
   *  over that title. Without it the dialog is named by `title`, or "Dialog". */
  ariaLabel?: string
  /** Review B2 (Runde 2, 20.09.2026): das Standardverhalten (AnimatePresence
   *  plus `{open && children}`) baut die Kinder beim Schliessen VOLLSTAENDIG
   *  ab. Fuer die meisten der zwoelf Einbindungen ist das richtig: ein
   *  Formular soll beim naechsten Oeffnen leer sein. Ein Fenster, das
   *  bezahlten, nicht wiederholbaren Fortschritt in seinem eigenen
   *  React-Baum haelt (die Preset-Werkstatt), darf X/Escape nicht mit
   *  diesem Fortschritt bezahlen lassen. `keepMounted` haelt die Kinder
   *  MONTIERT und blendet das Fenster nur aus, genau wie die Web-Referenz
   *  (the web app.../CreateExperimental.tsx`: `className={open?'fixed
   *  inset-0 z-50 ...':'hidden'}`). Alle Tastatur-/Fokus-/Escape-Effekte
   *  oben bleiben unveraendert an `open` gehaengt und schalten sich beim
   *  Ausblenden sauber ab; nur der Unmount entfaellt. */
  keepMounted?: boolean
}

// A modal is a real dialog, so it needs an OPAQUE, elevated surface — not the
// transparent `.glass-card` (which is `background: transparent` for inline
// panels). Without this the dialog read straight through to whatever tab was
// behind it and the white title vanished on a light surface.
//
// Bedienbarkeit (Audit Welle 2): das hier war optisch ein Dialog, für Tastatur
// und Screenreader aber keiner — kein Escape, keine Fokus-Falle, keine Rolle.
// Wer die Maus nicht benutzt, kam aus dem Ding nicht wieder heraus. Alles unten
// sitzt bewusst an DIESER einen Stelle, damit die zwölf Einbindungen es erben.
export function Modal({ open, onClose, title, titleMark, children, hideHeader, maxWidth = 'max-w-lg', panelRadius = 'rounded-2xl', panelPad = 'p-6', ariaLabel, keepMounted = false }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** Wohin der Fokus beim Schließen zurückkehrt. */
  const restoreRef = useRef<HTMLElement | null>(null)

  const reactId = useId()
  const titleId = `${reactId}-title`
  const hasVisibleTitle = !hideHeader && title.trim().length > 0

  /** Fokussierbare Elemente im Panel, in DOM-Reihenfolge. */
  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current
    if (!panel) return []
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable)
  }, [])

  // (1) Stapel-Anmeldung. Muss VOR den Tastatur-Effekten stehen, damit
  //     isTopDialog() bereits stimmt, wenn die Handler scharf werden.
  useEffect(() => {
    if (!open) return
    openDialog(reactId)
    return () => closeDialog(reactId)
  }, [open, reactId])

  // (2) Hintergrund inert. Reihenfolge ist wichtig: dieser Effekt wird VOR dem
  //     Fokus-Effekt deklariert, also läuft seine Aufräumfunktion auch zuerst.
  //     Sonst zeigte die Fokus-Rückgabe auf ein noch inertes Element und liefe
  //     ins Leere — `focus()` auf einen inerten Teilbaum ist ein No-op.
  useEffect(() => {
    if (!open) return
    const overlay = overlayRef.current
    if (!overlay) return

    // Nur Geschwister auf dem Pfad Overlay→<body>, nie ein Vorfahr: der Dialog
    // hängt im normalen Baum, `aria-hidden` auf #root würde ihn mitverstecken.
    //
    // Drei Ausnahmen:
    //  • bereits markierte Knoten (äußeres Modal) werden nicht erneut angefasst,
    //    sonst räumte das innere Modal beim Schließen dem äußeren die Sperre weg;
    //  • ein anderes Dialog-Overlay wird NIE markiert — zwei gleichzeitig
    //    geöffnete Modals sind Geschwister und würden sich sonst gegenseitig
    //    stilllegen, und zwar in Effekt-Reihenfolge, also auch das obere;
    //  • the bar of computer control (`data-lu-above-dialogs`) stays live: its
    //    Stop button must work while a question is open, also by mouse.
    const marked = backgroundNodesToHide<Element>(overlay, document.body).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        !el.hasAttribute('data-lu-dialog') &&
        !el.hasAttribute('data-lu-above-dialogs') &&
        !el.hasAttribute('inert') &&
        !el.hasAttribute('aria-hidden'),
    )
    for (const el of marked) {
      el.setAttribute('inert', '')
      el.setAttribute('aria-hidden', 'true')
    }
    return () => {
      for (const el of marked) {
        el.removeAttribute('inert')
        el.removeAttribute('aria-hidden')
      }
    }
  }, [open])

  // (3) Fokus hinein — und beim Schließen wieder dorthin zurück, wo er war.
  //     Das Zurückgeben ist der Teil, den man am deutlichsten merkt: ohne ihn
  //     landet der Fokus nach dem Schließen auf <body> und die nächste Tab-Taste
  //     fängt oben in der App wieder von vorn an.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null

    const items = focusables()
    const idx = pickInitialFocusIndex(items)
    if (idx >= 0) items[idx].focus()
    else panelRef.current?.focus()

    return () => {
      const target = restoreRef.current
      restoreRef.current = null
      if (target && target.isConnected) target.focus()
    }
  }, [open, focusables])

  // (4) Escape + Fokus-Falle. Der Listener hängt an `document`, weil der Fokus
  //     nach einem Klick auf nicht-fokussierbaren Text im Panel auf <body>
  //     landet und ein Handler am Panel dann nichts mehr sähe. Kindelemente, die
  //     Escape selbst brauchen (Inline-Umbenennen), stoppen die Propagation und
  //     kommen damit zuerst dran.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Liegen mehrere Dialoge übereinander, reagiert nur der oberste.
      if (!isTopDialog(reactId)) return

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const items = focusables()
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = nextFocusIndex(items.length, current, e.shiftKey)
      e.preventDefault()
      if (next >= 0) items[next].focus()
      else panel.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, reactId, onClose, focusables])

  const header = !hasVisibleTitle ? (
    <button
      onClick={onClose}
      data-dialog-close
      className="absolute top-3 right-3 z-10 flex h-[var(--control-h-sm)] w-[var(--control-h-sm)] items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
      aria-label="Close"
    >
      <X size={16} />
    </button>
  ) : (
    <div className="flex items-center justify-between gap-3 mb-4 -mt-1">
      <div className="min-w-0 flex items-center gap-2">
        <h2 id={titleId} className="min-w-0 text-base font-semibold tracking-tight text-gray-900 dark:text-white">{title}</h2>
        {titleMark}
      </div>
      <button
        onClick={onClose}
        data-dialog-close
        className="-mr-1.5 flex h-[var(--control-h-sm)] w-[var(--control-h-sm)] shrink-0 items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </div>
  )
  const panelClass = `relative z-10 w-full outline-none ${panelRadius} ${panelPad} lu-dialog ` + maxWidth
  // A window lower than the dialog (230 px in a tiling window manager) used to
  // cut the panel off at both ends: the overlay centred it and did not scroll,
  // so the buttons at the bottom could not be reached. The overlay scrolls now
  // and the row inside it is at least as high as the overlay, so a dialog that
  // fits is still centred and one that does not starts at the top and scrolls.
  // Percentages only: viewport units do not follow the zoom on the app root
  // (--ui-scale, see lib/popover-placement.ts). The panel itself does not
  // clip, so a menu that reaches out of a dialog still shows.
  const overlayClass = 'fixed inset-0 z-50 overflow-y-auto overscroll-contain'
  const backdropClass = 'fixed inset-0 lu-dialog-scrim'
  const rowClass = 'relative flex min-h-full items-center justify-center p-4'
  /** A click beside the panel closes, as the backdrop under it always did. */
  const closeBeside = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }
  const dialogA11y = hasVisibleTitle && !ariaLabel
    ? { 'aria-labelledby': titleId }
    : { 'aria-label': ariaLabel || title || 'Dialog' }

  if (keepMounted) {
    // Kein AnimatePresence, kein Unmount: dieselbe montiert-und-ausgeblendet
    // Regel wie die Web-Referenz. `children` bleibt im Baum, auch wenn
    // `open` false ist, also ueberlebt der Zustand, den es haelt, X und
    // Escape (Review B2).
    return (
      <div
        ref={overlayRef}
        data-lu-dialog={open ? '' : undefined}
        className={open ? overlayClass : 'hidden'}
      >
        <div className={backdropClass} onClick={onClose} />
        <div className={rowClass} onClick={closeBeside}>
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            {...dialogA11y}
            tabIndex={-1}
            className={panelClass}
          >
            {header}
            {children}
          </div>
        </div>
      </div>
    )
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          data-lu-dialog
          className={overlayClass}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className={backdropClass} onClick={onClose} />
          <div className={rowClass} onClick={closeBeside}>
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              {...dialogA11y}
              tabIndex={-1}
              className={panelClass}
              initial={{ scale: 0.97, y: 8, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.97, y: 8, opacity: 0 }}
              transition={SPRING_PANEL}
            >
              {header}
              {children}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
