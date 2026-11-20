// The Astra voice loop: typed access to its Rust commands
// (src-tauri/src/commands/voice_loop.rs).
//
// The loop is a Python sidecar that the desktop app installs and starts. The
// setup runs as a background job in Rust and survives this page, so the
// interface polls `getVoiceLoopInstallStatus` and can come back to a setup
// that is already running.
//
// `startVoiceLoop` is the only call that returns the launch token. Keep it in
// memory for the session and hand it to the sidecar as a bearer; do not put it
// in a store that is persisted and do not log it.

import { backendCall, isTauri } from './backend'

export const VOICE_LOOP_DEV_MODE_ERROR =
  'The voice loop needs the installed desktop app. The plain `npm run dev` server has no Rust process to install and run it in. Use `npm run tauri:dev` instead.'

export interface VoiceLoopPythonNeed {
  version: string
  installed: boolean
  downloadBytes: number
}

export interface VoiceLoopPackagesNeed {
  installed: boolean
  /** Measured once, not read from the lock file. Show it as "about". */
  downloadBytesEstimate: number
  diskBytesEstimate: number
  /** Pinned versions of the main packages, by package name. */
  versions: Record<string, string>
}

export interface VoiceLoopModelNeed {
  id: string
  name: string
  /** 'stt' | 'tts' | 'tts-voice' */
  role: string
  license: string
  /** Credit line the license asks for, when it does. */
  attribution: string | null
  bytes: number
  installed: boolean
}

/** One voice the answers can be spoken in. */
export interface VoiceLoopVoice {
  /** The name the voice engine knows it by, lower case. */
  name: string
  license: string
  /** Credit line the license asks for. */
  attribution: string | null
  bytes: number
  /** On this computer already, so picking it downloads nothing. */
  installed: boolean
}

/** What the setup would download and write right now. */
export interface VoiceLoopRequirements {
  supported: boolean
  /** A sentence for the user when `supported` is false. */
  unsupportedReason: string | null
  installed: boolean
  installDir: string
  /** Null on a machine the voice loop does not support. */
  python: VoiceLoopPythonNeed | null
  packages: VoiceLoopPackagesNeed
  /** The models of this installation. Of the voices only the chosen one. */
  models: VoiceLoopModelNeed[]
  modelsBytes: number
  /** The chosen voice. */
  voice: string
  /** Every voice LU offers. */
  voices: VoiceLoopVoice[]
  /** Everything still to download, with the package estimate when needed. */
  downloadBytes: number
  diskBytesNeeded: number
  /** Null when the free space could not be read. */
  diskBytesFree: number | null
  enoughSpace: boolean
}

export type VoiceLoopInstallState = 'idle' | 'running' | 'complete' | 'cancelled' | 'error'
export type VoiceLoopInstallPhase =
  | 'idle'
  | 'checking'
  | 'python'
  | 'environment'
  | 'packages'
  | 'models'
  | 'done'

export interface VoiceLoopInstallStatus {
  status: VoiceLoopInstallState
  phase: VoiceLoopInstallPhase
  /** One sentence for the headline. */
  message: string
  currentFile: string | null
  bytesDone: number
  bytesTotal: number
  bytesPerSecond: number
  logs: string[]
  /** The last lines pip printed, during the packages phase. */
  detail: string[]
  error: string | null
}

export type VoiceLoopState = 'stopped' | 'starting' | 'ready' | 'failed'

export interface VoiceLoopFailure {
  code: string
  message: string
}

export interface VoiceLoopStatus {
  supported: boolean
  unsupportedReason: string | null
  installed: boolean
  parts: { python: boolean; packages: boolean; models: boolean; complete: boolean }
  installing: boolean
  state: VoiceLoopState
  running: boolean
  ready: boolean
  port: number | null
  /** Why the sidecar is not running, after a failed start or a crash. */
  error: VoiceLoopFailure | null
  logTail: string[]
  versions: {
    sidecar: string | null
    python: string | null
    installedPython: string | null
    packages: Record<string, string>
    models: Array<{ id: string; name: string; role: string; revision: string }>
  }
  installDir: string
  /**
   * Memory the voice engine holds right now, in bytes, measured by the app:
   * the engine process and everything it started. Null while it is not running.
   */
  memoryBytes: number | null
}

/** Returned by `startVoiceLoop` and by nothing else. */
export interface VoiceLoopSession {
  port: number
  token: string
  /** `http://127.0.0.1:<port>` */
  baseUrl: string
  /** The chosen voice, for the session that is about to start. */
  voice: string
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(VOICE_LOOP_DEV_MODE_ERROR)
  return backendCall<T>(command, args)
}

/** Ask before starting the setup: sizes, free space, platform support. */
export function getVoiceLoopRequirements(): Promise<VoiceLoopRequirements> {
  return call<VoiceLoopRequirements>('voice_loop_requirements')
}

/**
 * Start the setup in the background. Safe to call again: it continues a
 * half-finished setup and does nothing on a complete one. `force` installs the
 * packages again and checks every model again (the repair).
 */
export function installVoiceLoop(options?: { force?: boolean }): Promise<{ status: 'started' | 'already_running' }> {
  return call('voice_loop_install', { force: options?.force ?? false })
}

export function getVoiceLoopInstallStatus(): Promise<VoiceLoopInstallStatus> {
  return call<VoiceLoopInstallStatus>('voice_loop_install_status')
}

/** Stop the running setup. Finished parts stay, a later run continues. */
export function cancelVoiceLoopInstall(): Promise<void> {
  return call<void>('voice_loop_install_cancel')
}

export function getVoiceLoopStatus(): Promise<VoiceLoopStatus> {
  return call<VoiceLoopStatus>('voice_loop_status')
}

/**
 * Start the sidecar and wait until it is ready. A cold start can take more
 * than 20 seconds. Calling it while the loop runs returns the same session.
 */
export function startVoiceLoop(): Promise<VoiceLoopSession> {
  return call<VoiceLoopSession>('voice_loop_start')
}

/**
 * Choose the voice the answers are spoken in. Before the first setup this
 * only records the choice. On an installed engine it resolves once the voice
 * is on this computer, which can include one small download; nothing else is
 * installed again, and the next session speaks in the new voice.
 */
export function setVoiceLoopVoice(voice: string): Promise<void> {
  return call<void>('voice_loop_set_voice', { voice })
}

/** How a voice is shown: its name with a capital, without underscores. */
export function voiceLabel(name: string): string {
  const words = name.replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

/** Resolves when the sidecar process is gone. */
export function stopVoiceLoop(): Promise<void> {
  return call<void>('voice_loop_stop')
}

/** Stop the sidecar and remove its Python, packages and models. */
export function uninstallVoiceLoop(): Promise<void> {
  return call<void>('voice_loop_uninstall')
}

/** Share of the current phase that is done, 0 to 1, or null when unknown. */
export function voiceLoopInstallFraction(status: Pick<VoiceLoopInstallStatus, 'bytesDone' | 'bytesTotal'>): number | null {
  if (!status.bytesTotal || status.bytesTotal <= 0) return null
  return Math.min(1, Math.max(0, status.bytesDone / status.bytesTotal))
}

/** The setup is over, one way or the other. */
export function voiceLoopInstallSettled(status: Pick<VoiceLoopInstallStatus, 'status'>): boolean {
  return status.status === 'complete' || status.status === 'cancelled' || status.status === 'error'
}
