// Astra computer use: typed access to its Rust commands
// (src-tauri/src/commands/computer.rs).
//
// Rust decides, this file only carries. Every command answers either with
// its result or with a refusal that has a stable code: a blocked app, an app
// the user has not approved, a screenshot that is too old, a stopped session.
// A refusal is a normal answer here, not an exception.

import { backendCall, isTauri } from './backend'

export const COMPUTER_DEV_MODE_ERROR =
  'Computer control needs the installed desktop app. The plain `npm run dev` server has no Rust process to see or control the screen with. Use `npm run tauri:dev` instead.'

export type RefusalCode =
  | 'no_session'
  | 'stopped'
  | 'paused'
  | 'blocked'
  /** LU's own panel was over the spot. It moved away or is gone: nothing ran, look again. */
  | 'covered'
  | 'needs_approval'
  /** The user has not said yes to computer control in this chat. */
  | 'needs_chat_permission'
  | 'needs_confirmation'
  | 'stale_frame'
  | 'password_field'
  | 'invalid'
  | 'unavailable'
  | 'failed'

export interface ComputerApp {
  /** What approvals are keyed by: exe file name, or bundle id on macOS. */
  key: string
  name: string
  exe: string | null
  bundleId: string | null
}

/** A permission of the operating system computer control cannot work without. Only macOS has them. */
export type ComputerPermission = 'accessibility' | 'screen_recording'

/** What the operating system has granted. Where nothing is needed, both count as granted. */
export interface ComputerPermissions {
  needed: boolean
  accessibility: boolean
  screenRecording: boolean
}

export interface Refusal {
  code: RefusalCode
  /** One English sentence for the user and the model. */
  message: string
  app?: ComputerApp
  /** `needs_confirmation` only: the action itself looks sensitive. */
  sensitive?: boolean
  /** `unavailable` only: the permission that is missing, when that is the reason. */
  permission?: ComputerPermission
  /** `covered` only: the corner the panel moved to. */
  corner?: PanelCorner
}

/** A corner of the display. The panel stands in one of the four. */
export type PanelCorner = 'top_right' | 'bottom_right' | 'bottom_left' | 'top_left'

export type Refused = { ok: false; refusal: Refusal }
export type Answer<T> = ({ ok: true } & T) | Refused

export type StopReason = 'user' | 'hotkey' | 'takeover'
export type GrantScope = 'once' | 'session'
export type Verdict = 'allowed' | 'needs_approval' | 'blocked'
export type BlockReason =
  | 'own_app'
  | 'terminal'
  | 'password_manager'
  | 'system_dialog'
  | 'security_settings'
  | 'launcher'
  | 'elevated'
  | 'no_foreground'

export interface ComputerSession {
  id: string
  /** The chat the user allowed computer control in, and this session works for. */
  chatId: string
  autonomous: boolean
  allowed: { key: string; scope: GrantScope }[]
  stopped: StopReason | null
  /** The user has the mouse or the keyboard and has not answered yet. */
  paused?: boolean
  frameId: number | null
}

export interface ComputerRect { x: number; y: number; width: number; height: number }

export interface ComputerWindow {
  id: number
  pid: number
  app: ComputerApp
  title: string
  className: string | null
  rect: ComputerRect
  minimized: boolean
  elevated: boolean | null
  isSelf: boolean
  verdict: Verdict
  blockReason: BlockReason | null
  foreground: boolean
}

export interface ComputerStatus {
  platform: string
  inputAvailable: boolean
  /** A sentence for the user when input cannot be simulated here. */
  inputError: string | null
  treeAvailable: boolean
  autonomyAvailable: boolean
  stopShortcut: string
  stopShortcutActive: boolean
  pauseShortcut?: string
  /** The main window shrinks to the panel while a task runs on this system. */
  shrinks?: boolean
  /** The edge of the display glows while a task runs on this system. */
  glows?: boolean
  session: ComputerSession | null
}

export interface ComputerMonitor {
  id: number
  name: string
  rect: ComputerRect
  pixelWidth: number
  pixelHeight: number
  scaleFactor: number
  primary: boolean
}

export interface ScreenResult {
  frameId: number
  monitor: ComputerMonitor
  width: number
  height: number
  scale: number
  /** Pointer on the 0..1000 grid, when it is on this monitor. */
  cursor: [number, number] | null
  foreground: ComputerWindow | null
  hiddenAreas: number
  /** The black areas that are LU's own windows, each [left, top, right, bottom] on the 0..1000 grid. */
  covered?: [number, number, number, number][]
  /** What the picture looks like, to tell whether a step changed anything. Null when no image was asked for. */
  look?: string | null
  mime: string | null
  /** Base64, without a data URL prefix. Null when no image was asked for. */
  image: string | null
}

export interface GuardResult {
  foreground: ComputerWindow | null
  verdict: Verdict
  blockReason: BlockReason | null
  message: string
}

export interface ActionResult {
  performed: string
  app: ComputerApp | null
  windowTitle: string | null
}

export interface TreeNode {
  depth: number
  role: string
  name: string
  /** [left, top, right, bottom] on the 0..1000 grid. */
  rect: [number, number, number, number]
  enabled: boolean
  focused?: boolean
  password?: boolean
  /** "checked", "unchecked" or "selected". */
  state?: string
  /** What a field holds right now, shortened. Never for a password field. */
  value?: string
}

export interface TreeResult {
  window: ComputerWindow
  nodes: TreeNode[]
  dropped: number
  passwordFocused: boolean
  warnings: string[]
}

/** The actions Rust knows. Coordinates are on the 0..1000 grid. */
export type ComputerAction =
  | { type: 'click' | 'double_click' | 'right_click' | 'move'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; to_x: number; to_y: number }
  | { type: 'scroll'; x?: number; y?: number; dx?: number; dy?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string; repeat?: number }
  | { type: 'wait'; ms: number }
  | { type: 'focus_window'; window_id: number }
  | { type: 'move_window'; window_id: number; x?: number; y?: number; dx?: number; dy?: number; width?: number; height?: number }

export interface ScreenOptions {
  monitorId?: number
  maxEdge?: number
  format?: 'jpeg' | 'png'
  quality?: number
  noImage?: boolean
}

function unavailable(): Refused {
  return { ok: false, refusal: { code: 'unavailable', message: COMPUTER_DEV_MODE_ERROR } }
}

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<Answer<T>> {
  if (!isTauri()) return unavailable()
  return backendCall<Answer<T>>(command, args)
}

export const getComputerStatus = () => call<ComputerStatus>('computer_status')

export const getComputerPermissions = () => call<{ permissions: ComputerPermissions }>('computer_permissions')

/**
 * Ask the operating system for one permission and open the place where the
 * user grants it. The first request is also what puts LU into that list.
 */
export const requestComputerPermission = (permission: ComputerPermission) =>
  call<{ permissions: ComputerPermissions }>('computer_permission_request', { permission })

/**
 * Make the operating system forget its entry for LU and ask again. For an
 * entry that is switched on in the list and still does not count: macOS ties
 * a permission to one exact build of an app without a fixed signature.
 */
export const resetComputerPermission = (permission: ComputerPermission) =>
  call<{ permissions: ComputerPermissions }>('computer_permission_reset', { permission })

/**
 * Open the question "may computer control work in this chat". `allowed` is
 * true when the user already said yes there since the app started; then no
 * question is open.
 */
export const askComputerChat = (chatId: string) => call<{ allowed: boolean }>('computer_chat_ask', { chatId })

/** The user's click on Allow or Deny in the card of that question. Nothing else may call this. */
export const answerComputerChat = (chatId: string, allow: boolean) =>
  call<{ allowed: boolean }>('computer_chat_answer', { chatId, allow })

/** Rust begins a session only for a chat the user has allowed. */
export const beginComputerSession = (options: { chatId: string; autonomous?: boolean; maxFrameAgeMs?: number }) =>
  call<{ session: ComputerSession; stopShortcut: string | null; pauseShortcut?: string | null }>('computer_session_begin', { options })

export const allowComputerApp = (sessionId: string, appKey: string, scope: GrantScope) =>
  call<{ session: ComputerSession }>('computer_session_allow_app', { sessionId, appKey, scope })

export const revokeComputerApp = (sessionId: string, appKey: string) =>
  call<{ session: ComputerSession }>('computer_session_revoke_app', { sessionId, appKey })

/**
 * The Autonomous switch, for the session that is running. The session stays
 * the same one, with its approvals and its latest look.
 */
export const setComputerSessionAutonomy = (sessionId: string, autonomous: boolean) =>
  call<{ session: ComputerSession }>('computer_session_set_autonomous', { sessionId, autonomous })

export const endComputerSession = (sessionId: string) =>
  call<{ ended: boolean }>('computer_session_end', { sessionId })

/** The emergency stop. Safe to call at any time, with or without a session. */
export const stopComputer = () => call<{ session: ComputerSession | null }>('computer_stop')

/** Bring LU's window forward because a question for the user waits in it. */
export const requestComputerAttention = () => call<Record<string, never>>('computer_request_attention')

export const getComputerGuard = () => call<GuardResult>('computer_guard')

export const getComputerWindows = () =>
  call<{ foreground: ComputerWindow | null; windows: ComputerWindow[] }>('computer_windows')

export const captureComputerScreen = (sessionId: string, options: ScreenOptions = {}) =>
  call<ScreenResult>('computer_screen', { sessionId, options })

export const runComputerAction = (
  sessionId: string,
  action: ComputerAction,
  opts: { frameId?: number | null; confirmed?: boolean; refocusWindow?: number | null } = {},
) =>
  call<ActionResult>('computer_action', {
    sessionId,
    request: {
      action,
      frameId: opts.frameId ?? null,
      confirmed: opts.confirmed === true,
      // The window that was in front before LU's own question took the focus.
      refocusWindow: opts.refocusWindow ?? null,
    },
  })

export const readComputerTree = (sessionId: string, limits: { maxDepth?: number; maxNodes?: number } = {}) =>
  call<TreeResult>('computer_tree', { sessionId, maxDepth: limits.maxDepth ?? null, maxNodes: limits.maxNodes ?? null })

/** The event Rust emits when the shortcut or a takeover stops a session. */
export const COMPUTER_STOPPED_EVENT = 'computer://stopped'
/** The event Rust emits when the session pauses: the user's hand, or the pause shortcut. */
export const COMPUTER_PAUSED_EVENT = 'computer://paused'

/**
 * Pause for the user, as the pause shortcut does. `paused` is false when
 * there is nothing to pause: no session, or a stopped one.
 */
export const pauseComputer = () => call<{ paused: boolean }>('computer_pause')

/**
 * The user's answer to a pause. This is the only call that lets a paused
 * session go on, and the paused view is its only caller (a test keeps it so).
 */
export const answerComputerTakeover = (go: boolean) =>
  call<{ paused: boolean; session: ComputerSession | null }>('computer_takeover_answer', { continue: go })

/** Has the user reached for the mouse or the keyboard since LU last acted? */
export const watchComputer = () => call<{ paused: boolean }>('computer_watch')

/** What LU shows of itself while it works on the screen. */
export type SurfaceMode = 'window' | 'panel' | 'pause'

export interface SurfaceApplied {
  /** What the window is now. `window` wherever it does not shrink. */
  mode: SurfaceMode
  glow: boolean
  /** The window is see-through around the panel, so the panel can be round. */
  glass: boolean
  /** The corner the panel is in, or comes up in. */
  corner?: PanelCorner
}

/**
 * Ask for a surface. Sent again every few seconds while computer control is
 * busy: Rust puts everything back by itself when the interface goes silent.
 * `still` is the user's wish for less motion: the panel then changes corners
 * in one step.
 */
export const setComputerSurface = (want: { mode: SurfaceMode; active: boolean; focus: boolean; monitorId: number | null; still: boolean }) =>
  call<SurfaceApplied>('computer_surface', want)

/**
 * The grip of the panel: send it to a corner, or with null to the next one
 * around the display. The grip is its only caller (a test keeps it so).
 */
export const moveComputerPanel = (corner: PanelCorner | null) =>
  call<SurfaceApplied>('computer_surface_corner', { corner })
