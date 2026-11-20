// The state of one voice session and every way it can change.
//
// The controller (api/voice-session.ts) turns what happens (a click, a
// message from the voice loop, a tool that asks for approval) into the events
// below. This file decides what the surface shows for each of them, and
// nothing else: no audio, no network, no timers. That keeps the whole
// behaviour of the surface testable without a microphone.

import type { ToolArgs } from '../../api/mcp/types'

/** Where a session is in its life. */
export type VoicePhase = 'idle' | 'starting' | 'live' | 'stopping' | 'error'

/** What a start is waiting for, in the order it happens. */
export type VoiceStartStep = 'microphone' | 'engine' | 'model' | 'permission' | 'connecting' | 'warming'

/** What a live session is doing right now. */
export type VoiceActivity = 'listening' | 'hearing' | 'thinking' | 'speaking' | 'tool'

export type VoiceErrorKind =
  | 'microphone-denied'
  | 'microphone-missing'
  | 'microphone-busy'
  | 'no-model'
  | 'unsupported-model'
  | 'signed-out'
  | 'start-failed'
  | 'connection-lost'
  | 'model-error'

export interface VoiceError {
  kind: VoiceErrorKind
  message: string
}

export interface VoiceLine {
  id: number
  /** A thought is what the model reasoned before an answer. It is shown, never spoken. */
  role: 'user' | 'assistant' | 'thought'
  text: string
  /** False while the words are still coming in. */
  final: boolean
  /** Thoughts only: how long the model thought, once it is done. */
  secs?: number
  /** Thoughts only: it reached the length set in the Voice settings and was ended there. */
  cut?: boolean
  /**
   * User lines only: the part of the text that is settled. A sentence with a
   * pause in it arrives as several transcripts, and they are one line.
   */
  head?: string
}

export interface VoiceToolLine {
  id: string
  name: string
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'rejected'
  /** What the tool was called with, for its card in the transcript. */
  args: ToolArgs
  /** What it answered, once it is done. */
  result?: string
  /** How long it ran, in ms, once it is done. */
  durationMs?: number
  /** Id of the transcript line it came after, 0 before the first one. */
  after: number
}

export interface VoiceApprovalRequest {
  id: string
  name: string
  args: ToolArgs
}

export interface VoiceMic {
  deviceId: string
  label: string
}

export interface VoiceSessionState {
  phase: VoicePhase
  startStep: VoiceStartStep | null
  /** The voice loop process was not running before this start. */
  coldStart: boolean
  /** Epoch ms of the click, for the elapsed time while starting. */
  startedAt: number | null
  activity: VoiceActivity
  muted: boolean
  lines: VoiceLine[]
  tools: VoiceToolLine[]
  approval: VoiceApprovalRequest | null
  /** Name of the tool that is running, for the status line. */
  runningTool: string | null
  /** End of speech to first sound of the answer, last round, in ms. */
  latencyMs: number | null
  error: VoiceError | null
  /** One calm sentence under the status, for example "no tools". */
  notice: string | null
  /**
   * One piece of work failed and the session goes on (lib/voice/loop-errors.ts).
   * Shown in place of the notice until the user speaks again.
   */
  hint: string | null
  /**
   * Why the last session ended, when it was not the Stop button and not an
   * error: the user left the surface, or a repair needed the voice engine.
   * Shown in place of "Ready" until the next start, so no session ends
   * without a word.
   */
  endNote: string | null
  /**
   * The model this session talks to, as the picker shows it. Null once the
   * session is over: what stands on the idle surface is the model picked in
   * Chat now, which is the one the next session would talk to.
   */
  modelLabel: string | null
  mics: VoiceMic[]
  micId: string | null
  nextLineId: number
}

export const VOICE_IDLE: VoiceSessionState = {
  phase: 'idle',
  startStep: null,
  coldStart: false,
  startedAt: null,
  activity: 'listening',
  muted: false,
  lines: [],
  tools: [],
  approval: null,
  runningTool: null,
  latencyMs: null,
  error: null,
  notice: null,
  hint: null,
  endNote: null,
  modelLabel: null,
  mics: [],
  micId: null,
  nextLineId: 1,
}

export type VoiceEvent =
  | { type: 'start'; at: number; muted: boolean }
  | { type: 'start-step'; step: VoiceStartStep; coldStart?: boolean }
  | { type: 'brain'; modelLabel: string; notice: string | null }
  | { type: 'ready' }
  | { type: 'user-started' }
  | { type: 'user-stopped' }
  | { type: 'user-text'; text: string; final: boolean }
  | { type: 'bot-thinking' }
  | { type: 'bot-text'; text: string }
  | { type: 'thought-text'; text: string }
  | { type: 'thought-end'; secs?: number; cut?: boolean }
  | { type: 'bot-speaking' }
  | { type: 'bot-silent' }
  | { type: 'tool-waiting'; id: string; name: string; args: ToolArgs }
  | { type: 'tool-running'; id: string; name: string; args?: ToolArgs }
  | { type: 'tool-done'; id: string; status: 'completed' | 'failed' | 'rejected'; result?: string; durationMs?: number }
  | { type: 'latency'; ms: number }
  | { type: 'hint'; text: string }
  | { type: 'muted'; muted: boolean }
  | { type: 'mics'; mics: VoiceMic[]; micId: string | null }
  | { type: 'stopping' }
  | { type: 'stopped'; note?: string }
  | { type: 'failed'; error: VoiceError }

/** The longest transcript the surface keeps. The chat history keeps all of it. */
export const MAX_VOICE_LINES = 200

/** The longest tool answer a card keeps. The model gets all of it either way. */
export const MAX_VOICE_TOOL_RESULT = 20_000

function newTool(state: VoiceSessionState, id: string, name: string, args: ToolArgs, status: 'waiting' | 'running'): VoiceToolLine {
  return { id, name, status, args, after: state.lines[state.lines.length - 1]?.id ?? 0 }
}

function closeOpenLine(lines: VoiceLine[], role: VoiceLine['role']): VoiceLine[] {
  const last = lines[lines.length - 1]
  if (!last || last.role !== role || last.final) return lines
  // A line that never got a word is dropped, not shown as an empty bubble.
  if (!last.text.trim()) return lines.slice(0, -1)
  return [...lines.slice(0, -1), { ...last, final: true }]
}

/** Whatever the model was in the middle of, a thought or an answer, is over. */
function closeModelLines(lines: VoiceLine[]): VoiceLine[] {
  return closeOpenLine(closeOpenLine(lines, 'thought'), 'assistant')
}

function trim(lines: VoiceLine[]): VoiceLine[] {
  return lines.length > MAX_VOICE_LINES ? lines.slice(lines.length - MAX_VOICE_LINES) : lines
}

/** What the session falls back to when nothing in particular is happening. */
function restingActivity(state: VoiceSessionState): VoiceActivity {
  if (state.approval || state.runningTool) return 'tool'
  return 'listening'
}

/**
 * The microphone is open while a local model reads its instructions, and what
 * is said then is answered once it is through. So the words are shown from
 * that step on, not only from "ready".
 */
function takesWords(state: VoiceSessionState): boolean {
  return state.phase === 'live' || (state.phase === 'starting' && state.startStep === 'warming')
}

export function reduceVoiceSession(state: VoiceSessionState, event: VoiceEvent): VoiceSessionState {
  // A session that is over ignores what still trickles in from its
  // connection. Only a new start, the device list and the end of a stop pass.
  const over = state.phase === 'idle' || state.phase === 'error'
  if (over && event.type !== 'start' && event.type !== 'mics' && event.type !== 'muted') return state
  if (state.phase === 'stopping' && event.type !== 'stopped' && event.type !== 'failed' && event.type !== 'mics') return state

  switch (event.type) {
    case 'start':
      return {
        ...VOICE_IDLE,
        mics: state.mics,
        micId: state.micId,
        phase: 'starting',
        startStep: 'microphone',
        startedAt: event.at,
        muted: event.muted,
      }
    case 'start-step':
      if (state.phase !== 'starting') return state
      return { ...state, startStep: event.step, coldStart: event.coldStart ?? state.coldStart }
    case 'hint':
      return state.phase === 'live' ? { ...state, hint: event.text } : state
    case 'brain':
      return { ...state, modelLabel: event.modelLabel, notice: event.notice }
    case 'ready': {
      if (state.phase !== 'starting') return state
      // A sentence said during the warm up is waiting for its answer.
      const last = state.lines[state.lines.length - 1]
      const activity = last?.role === 'user' ? (last.final ? 'thinking' : 'hearing') : last && !last.final ? 'thinking' : 'listening'
      return { ...state, phase: 'live', startStep: null, activity }
    }
    case 'user-started': {
      if (state.phase !== 'live') return state
      // Speaking over the answer ends it. What was said so far stays.
      return { ...state, activity: 'hearing', hint: null, lines: closeModelLines(state.lines) }
    }
    case 'user-stopped':
      if (state.phase !== 'live') return state
      return { ...state, activity: state.activity === 'hearing' ? 'thinking' : state.activity }
    case 'user-text': {
      if (!takesWords(state)) return state
      const text = event.text.trim()
      const last = state.lines[state.lines.length - 1]
      // Still the same turn as long as nothing was answered in between.
      if (last && last.role === 'user') {
        const head = last.final ? last.text : last.head ?? ''
        const joined = [head, text].filter(Boolean).join(' ')
        if (!joined) return { ...state, lines: state.lines.slice(0, -1) }
        const next: VoiceLine = { ...last, text: joined, final: event.final, head }
        return { ...state, lines: [...state.lines.slice(0, -1), next] }
      }
      if (!text) return state
      const lines = closeModelLines(state.lines)
      return {
        ...state,
        lines: trim([...lines, { id: state.nextLineId, role: 'user', text, final: event.final }]),
        nextLineId: state.nextLineId + 1,
      }
    }
    case 'bot-thinking':
      if (state.phase !== 'live') return state
      return { ...state, activity: state.activity === 'speaking' ? 'speaking' : 'thinking' }
    case 'bot-text': {
      if (!takesWords(state) || !event.text) return state
      const last = state.lines[state.lines.length - 1]
      if (last && last.role === 'assistant' && !last.final) {
        return { ...state, lines: [...state.lines.slice(0, -1), { ...last, text: last.text + event.text }] }
      }
      const lines = closeOpenLine(closeOpenLine(state.lines, 'user'), 'thought')
      return {
        ...state,
        lines: trim([...lines, { id: state.nextLineId, role: 'assistant', text: event.text, final: false }]),
        nextLineId: state.nextLineId + 1,
      }
    }
    case 'thought-text': {
      if (!takesWords(state) || !event.text) return state
      const last = state.lines[state.lines.length - 1]
      if (last && last.role === 'thought' && !last.final) {
        return { ...state, lines: [...state.lines.slice(0, -1), { ...last, text: last.text + event.text }] }
      }
      const lines = closeOpenLine(closeOpenLine(state.lines, 'user'), 'assistant')
      return {
        ...state,
        lines: trim([...lines, { id: state.nextLineId, role: 'thought', text: event.text, final: false }]),
        nextLineId: state.nextLineId + 1,
      }
    }
    case 'thought-end': {
      const last = state.lines[state.lines.length - 1]
      if (!last || last.role !== 'thought' || last.final) return state
      if (!last.text.trim()) return { ...state, lines: state.lines.slice(0, -1) }
      const done: VoiceLine = { ...last, final: true, ...(event.secs !== undefined ? { secs: event.secs } : {}), ...(event.cut ? { cut: true } : {}) }
      return { ...state, lines: [...state.lines.slice(0, -1), done] }
    }
    case 'bot-speaking':
      if (state.phase !== 'live') return state
      return { ...state, activity: 'speaking' }
    case 'bot-silent':
      if (state.phase !== 'live') return state
      return {
        ...state,
        activity: state.activity === 'hearing' ? 'hearing' : restingActivity(state),
        lines: closeModelLines(state.lines),
      }
    case 'tool-waiting': {
      if (state.phase !== 'live') return state
      const tools = state.tools.some((t) => t.id === event.id)
        ? state.tools
        : [...state.tools, newTool(state, event.id, event.name, event.args, 'waiting')]
      return { ...state, tools, approval: { id: event.id, name: event.name, args: event.args }, activity: 'tool' }
    }
    case 'tool-running': {
      if (state.phase !== 'live') return state
      const known = state.tools.some((t) => t.id === event.id)
      const tools = known
        ? state.tools.map((t) => (t.id === event.id ? { ...t, status: 'running' as const } : t))
        : [...state.tools, newTool(state, event.id, event.name, event.args ?? {}, 'running')]
      return {
        ...state,
        tools,
        approval: state.approval?.id === event.id ? null : state.approval,
        runningTool: event.name,
        activity: state.activity === 'speaking' || state.activity === 'hearing' ? state.activity : 'tool',
      }
    }
    case 'tool-done': {
      const tool = state.tools.find((t) => t.id === event.id)
      if (!tool) return state
      const result = event.result?.slice(0, MAX_VOICE_TOOL_RESULT)
      const tools = state.tools.map((t) => (t.id === event.id ? { ...t, status: event.status, result, durationMs: event.durationMs } : t))
      const next = {
        ...state,
        tools,
        approval: state.approval?.id === event.id ? null : state.approval,
        runningTool: state.runningTool === tool.name ? null : state.runningTool,
      }
      return { ...next, activity: next.activity === 'tool' ? (next.approval || next.runningTool ? 'tool' : 'thinking') : next.activity }
    }
    case 'latency':
      if (!Number.isFinite(event.ms) || event.ms < 0) return state
      return { ...state, latencyMs: Math.round(event.ms) }
    case 'muted':
      return { ...state, muted: event.muted }
    case 'mics':
      return { ...state, mics: event.mics, micId: event.micId }
    case 'stopping':
      return { ...state, phase: 'stopping', approval: null, runningTool: null }
    case 'stopped':
      return {
        ...state,
        phase: 'idle',
        startStep: null,
        startedAt: null,
        activity: 'listening',
        approval: null,
        runningTool: null,
        endNote: event.note ?? null,
        modelLabel: null,
        lines: closeOpenLine(closeModelLines(state.lines), 'user'),
        tools: state.tools.map((t) => (t.status === 'waiting' || t.status === 'running' ? { ...t, status: 'failed' as const } : t)),
      }
    case 'failed':
      return {
        ...state,
        phase: 'error',
        startStep: null,
        startedAt: null,
        approval: null,
        runningTool: null,
        error: event.error,
        modelLabel: null,
        lines: closeOpenLine(closeModelLines(state.lines), 'user'),
        tools: state.tools.map((t) => (t.status === 'waiting' || t.status === 'running' ? { ...t, status: 'failed' as const } : t)),
      }
  }
}

/**
 * The sentence shown while a session starts. The first start after the app
 * opened loads the speech models, which takes far longer than every later
 * one, so it says so instead of showing a bare spinner for a minute.
 */
export function startLabel(step: VoiceStartStep | null, coldStart: boolean, elapsedSecs: number): string {
  switch (step) {
    case 'microphone':
      return 'Waiting for the microphone'
    case 'engine':
      if (!coldStart) return 'Starting voice'
      return elapsedSecs < 8
        ? 'Loading the speech models'
        : 'Loading the speech models. The first start after opening the app takes up to a minute.'
    case 'model':
      return 'Getting the chat model ready'
    case 'permission':
      // "Where it may work" is "Whole computer", and this start of the app
      // has not asked yet. The window of the system can open behind others.
      return `Waiting for your answer in the system window "${WHOLE_COMPUTER_WINDOW_TITLE}"`
    case 'connecting':
      return 'Connecting'
    case 'warming':
      // A local model reads its instructions once, so the first answer comes
      // as fast as every later one.
      return elapsedSecs < 20 ? 'Getting ready' : 'Getting ready. A local model reads its instructions once per session.'
    default:
      return 'Starting voice'
  }
}

/** The title of the window in which the system asks for "Whole computer" (fs_whole_computer in Rust). */
export const WHOLE_COMPUTER_WINDOW_TITLE = 'Let Voice work on the whole computer?'

/** A start that takes longer than this has failed, whatever it was waiting for. */
export const VOICE_START_TIMEOUT_MS = 180_000
/** How long a start waits for the user's answer in the window of the system. That time is the user's, not the start's. */
export const VOICE_CONSENT_TIMEOUT_MS = 300_000

/**
 * When a start gives up, and what it says then. The wait for the user's
 * answer has its own limit and its own sentence: nothing is broken, so
 * nothing is to be repaired.
 */
export function startTimeout(step: VoiceStartStep | null): { ms: number; message: string } {
  if (step === 'permission') {
    return {
      ms: VOICE_CONSENT_TIMEOUT_MS,
      message: `Voice did not start because the system window "${WHOLE_COMPUTER_WINDOW_TITLE}" was not answered. It may be behind other windows. Answer it and start again, or set "Where it may work" to "Workspace only".`,
    }
  }
  return {
    ms: VOICE_START_TIMEOUT_MS,
    message: 'Voice did not start within three minutes. Start it again. If this keeps happening, run Repair in the voice settings.',
  }
}

export function latencyLabel(ms: number | null): string | null {
  if (ms === null) return null
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
