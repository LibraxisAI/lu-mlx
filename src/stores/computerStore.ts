import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { ComputerApp, ComputerPermission, ComputerSession, PanelCorner, StopReason, SurfaceMode } from '../api/computer'
import { isRecord, prop } from '../types/json-guards'
import { HOME_CORNER } from '../lib/computer/surface'

/**
 * Computer control: what the user decided, and what is going on right now.
 *
 * Three things are kept across restarts and nothing else: whether the
 * feature is on at all (off unless the user turns it on), the apps the user
 * chose "Always allow" for, and which model looks at the screen during a
 * task. The session, the questions waiting for an answer and
 * above all the autonomy switch live in memory only. Autonomy is a decision
 * for one session; a restart always comes back supervised. The shape of the
 * window (panel, paused view) is never kept either: after a restart
 * the window is the window.
 */

export interface AllowedApp {
  key: string
  name: string
}

/** "May computer control work in this chat?" The answer goes through api/computer-chat. */
export interface ComputerChatAsk {
  id: string
  /** What Rust keys the yes by. */
  chatKey: string
  /** The conversation whose tool call shows the card. Null when the run has none. */
  conversationId: string | null
  /** Asked by a voice session: the voice surface shows it, and only a click answers. */
  voice: boolean
}

/** A question for the user. The answer goes through lib/computer/prompts. */
export type ComputerPrompt =
  | { kind: 'app'; id: string; app: ComputerApp; windowTitle: string | null }
  | { kind: 'confirm'; id: string; app: ComputerApp | null; description: string; reason: string | null; sensitive: boolean }
  /** The operating system has not granted LU a permission yet. Answered by granting it, not by a button here. */
  | { kind: 'permission'; id: string; permission: ComputerPermission }

/** Why computer control stopped. Rust knows the first three; the time of a call running out is the interface's. */
export type StopCause = StopReason | 'timeout'

export interface ComputerStopped {
  reason: StopCause
  message: string
  /** The run that was stopped. It may not start a new session by itself. */
  runToken: string | null
  /**
   * Epoch ms of the stop. A run that was already going then stays stopped too:
   * the user may press Stop while the model is still thinking, before its
   * first call. Zero once the user asked again.
   */
  at?: number
  /**
   * The user closed the note. The stop itself still holds: the stopped run
   * stays stopped and the next request starts a fresh session.
   */
  dismissed?: boolean
}

export type ScreenInput = 'auto' | 'list' | 'picture'

/** One step of a running screen task, for the status bar and the chat. */
export interface ComputerTaskStep {
  n: number
  /** What the step does, without typed text: "Click at 662, 511". */
  label: string
  /** Null while it runs. */
  ok: boolean | null
}

/** A `computer_task` that is running right now. */
export interface ComputerTask {
  goal: string
  maxSteps: number
  steps: ComputerTaskStep[]
  /** What the loop is waiting for. */
  phase: 'looking' | 'deciding' | 'acting'
  /** The model that looks at the screen, as the picker names it. */
  modelLabel: string
  /** The model cannot see images and works from the element list of the window. */
  blind?: boolean
}

interface ComputerState {
  // Persisted
  enabled: boolean
  alwaysAllowed: AllowedApp[]
  /**
   * The model that looks at the screen and picks the next action during a
   * task, as the model picker names it. Null means the chat model, when it
   * can see images.
   */
  executorModel: string | null
  /**
   * What the model that works on the screen is given: 'auto' is the picture
   * when it can see, and the list of elements where the system has one;
   * 'list' is the list alone, also for a model that can see; 'picture' is
   * the picture alone. No switch in the interface yet: the default is what
   * the measurements on Windows say works best.
   */
  screenInput: ScreenInput

  // In memory only
  session: ComputerSession | null
  stopShortcut: string | null
  autonomous: boolean
  stopped: ComputerStopped | null
  prompt: ComputerPrompt | null
  /**
   * The first use of computer control in a chat waits for the user's yes.
   * The card of the tool call in that chat shows it (in Voice: the voice
   * surface). It is not a `prompt`: no setting, no spoken yes and no
   * autonomous session answers it.
   */
  chatAsk: ComputerChatAsk | null
  /** A calm line for the status bar: the last refusal or screen warning. */
  notice: string | null
  /** App in front at the last look, for the status bar. */
  currentApp: string | null
  task: ComputerTask | null
  /** A call of computer control is running or waiting its turn right now. */
  working: boolean
  pauseShortcut: string | null
  /**
   * The user moved the mouse, pressed a key or pressed the pause shortcut.
   * Nothing runs until they answer in the paused view. Rust holds the pause;
   * this only says that the question is on screen.
   */
  paused: boolean
  /** The user asked for this pause by voice, without touching the mouse or the keyboard. */
  pauseAsked: boolean
  /** LU paused by itself because its steps changed nothing. The sentence the paused view shows. */
  pauseWhy: string | null
  /**
   * The user just allowed computer control in a chat: the short note above
   * the input field says that LU controls the computer now. Epoch ms of the
   * yes; the note takes itself down.
   */
  startNote: number | null
  /** Does the window become the small panel while LU works? Null until Rust has answered once. */
  shrinks: boolean | null
  /** What the main window is right now, as Rust last applied it. */
  surface: SurfaceMode
  /** The window is see-through around the panel. */
  glass: boolean
  /** The corner of the display the panel is in, as Rust last said. */
  corner: PanelCorner
  /** The display of the latest look, as Rust names it. */
  monitorId: number | null
  /** How many places above an input field can show a question right now. */
  questionSlots: string[]

  setEnabled: (enabled: boolean) => void
  addAlwaysAllowed: (app: AllowedApp) => void
  removeAlwaysAllowed: (key: string) => void
  setAutonomous: (autonomous: boolean) => void
  setSession: (session: ComputerSession | null, stopShortcut?: string | null) => void
  setStopped: (stopped: ComputerStopped | null) => void
  setPrompt: (prompt: ComputerPrompt | null) => void
  setChatAsk: (chatAsk: ComputerChatAsk | null) => void
  setNotice: (notice: string | null) => void
  setCurrentApp: (name: string | null) => void
  setExecutorModel: (model: string | null) => void
  setTask: (task: ComputerTask | null) => void
  setWorking: (working: boolean) => void
  setPaused: (paused: boolean) => void
  setSurface: (surface: SurfaceMode, glass?: boolean) => void
  setStartNote: (startNote: number | null) => void
  setShrinks: (shrinks: boolean) => void
  setCorner: (corner: PanelCorner) => void
  setMonitorId: (monitorId: number | null) => void
  addQuestionSlot: (id: string) => void
  removeQuestionSlot: (id: string) => void
}

export const useComputerStore = create<ComputerState>()(
  persist(
    (set) => ({
      enabled: false,
      alwaysAllowed: [],
      executorModel: null,
      screenInput: 'auto',
      task: null,
      working: false,
      session: null,
      stopShortcut: null,
      autonomous: false,
      stopped: null,
      prompt: null,
      chatAsk: null,
      notice: null,
      currentApp: null,
      pauseShortcut: null,
      paused: false,
      pauseAsked: false,
      pauseWhy: null,
      surface: 'window',
      startNote: null,
      shrinks: null,
      glass: false,
      corner: HOME_CORNER,
      monitorId: null,
      questionSlots: [],

      setEnabled: (enabled) => set({ enabled }),
      addAlwaysAllowed: (app) =>
        set((state) => {
          const key = app.key.trim().toLowerCase()
          if (!key) return state
          const rest = state.alwaysAllowed.filter((a) => a.key !== key)
          return { alwaysAllowed: [...rest, { key, name: app.name.trim() || key }].sort((a, b) => a.name.localeCompare(b.name)) }
        }),
      removeAlwaysAllowed: (key) =>
        set((state) => ({ alwaysAllowed: state.alwaysAllowed.filter((a) => a.key !== key.trim().toLowerCase()) })),
      setAutonomous: (autonomous) => set({ autonomous }),
      setSession: (session, stopShortcut) =>
        set((state) => ({
          session,
          monitorId: session ? state.monitorId : null,
          stopShortcut: stopShortcut === undefined ? state.stopShortcut : stopShortcut,
          // Autonomy never outlives the session it was switched on for.
          autonomous: session ? state.autonomous : false,
          currentApp: session ? state.currentApp : null,
        })),
      setStopped: (stopped) => set({ stopped }),
      setPrompt: (prompt) => set({ prompt }),
      setChatAsk: (chatAsk) => set({ chatAsk }),
      setNotice: (notice) => set({ notice }),
      setCurrentApp: (currentApp) => set({ currentApp }),
      setExecutorModel: (executorModel) => set({ executorModel: executorModel?.trim() || null }),
      setTask: (task) => set({ task }),
      setWorking: (working) => set((state) => (state.working === working ? state : { working })),
      setPaused: (paused) => set((state) => (state.paused === paused && (paused || (!state.pauseAsked && state.pauseWhy === null)) ? state : { paused, pauseAsked: paused && state.pauseAsked, pauseWhy: paused ? state.pauseWhy : null })),
      setStartNote: (startNote) => set({ startNote }),
      setShrinks: (shrinks) => set((state) => (state.shrinks === shrinks ? state : { shrinks })),
      setSurface: (surface, glass) => set((state) => (state.surface === surface && (glass === undefined || state.glass === glass) ? state : { surface, glass: glass ?? state.glass })),
      setCorner: (corner) => set((state) => (state.corner === corner ? state : { corner })),
      setMonitorId: (monitorId) => set((state) => (state.monitorId === monitorId ? state : { monitorId })),
      addQuestionSlot: (id) => set((state) => (state.questionSlots.includes(id) ? state : { questionSlots: [...state.questionSlots, id] })),
      removeQuestionSlot: (id) => set((state) => (state.questionSlots.includes(id) ? { questionSlots: state.questionSlots.filter((slot) => slot !== id) } : state)),
    }),
    {
      name: 'locally-uncensored-computer',
      storage: safeJSONStorage(),
      version: 1,
      migrate: migrateComputerState,
      // Exactly these four. Adding `autonomous` here would make autonomy a
      // setting, and it must stay a per-session switch.
      partialize: (state) => ({ enabled: state.enabled, alwaysAllowed: state.alwaysAllowed, executorModel: state.executorModel, screenInput: state.screenInput }),
    },
  ),
)

/**
 * What is on disk was written by some build, not necessarily this one. Only
 * a real `true` turns computer control on, and only well formed entries stay
 * on the always allowed list: a blob that cannot be read leaves the feature
 * off and the list empty.
 */
export function migrateComputerState(persisted: unknown): ComputerState {
  const list = prop(persisted, 'alwaysAllowed')
  const alwaysAllowed: AllowedApp[] = []
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry)) continue
      const key = typeof entry.key === 'string' ? entry.key.trim().toLowerCase() : ''
      if (!key) continue
      alwaysAllowed.push({ key, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : key })
    }
  }
  // zustand types migrate as returning the full store; a blob only carries
  // the partialized slice and `merge` puts the rest back.
  const executor = prop(persisted, 'executorModel')
  const input = prop(persisted, 'screenInput')
  return {
    enabled: prop(persisted, 'enabled') === true,
    alwaysAllowed,
    executorModel: typeof executor === 'string' && executor.trim() ? executor.trim() : null,
    screenInput: input === 'list' || input === 'picture' ? input : 'auto',
  } as ComputerState
}
