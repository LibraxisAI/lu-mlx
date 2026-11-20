import { toolFace } from '../status/run-status'
import type { StatusKind } from '../status/glyph-motifs'
import type { VoiceSessionState } from '../../lib/voice/session-state'

/** What the status line of a live voice session shows. */
export interface VoiceStatus {
  /**
   * The state in the terms of the run status of the chat, for a piece of work
   * (its seconds are counted). Null while the session listens or speaks.
   */
  kind: StatusKind | null
  word: string
  /** The step of a running screen task. */
  detail?: string
}

/**
 * The state of a live session in the words of the run status line of the
 * chat: a running tool reads "Writing", "Running", "Searching", not its
 * technical name.
 */
export function voiceStatus(
  state: Pick<VoiceSessionState, 'activity' | 'muted' | 'approval' | 'runningTool'>,
  /** A screen task that is running: its latest step, whether it waits for an answer, and whether it is paused. */
  screen?: { step: string | null; asking: boolean; paused?: boolean } | null,
): VoiceStatus {
  if (state.approval) return { kind: 'approval', word: 'Waiting for your approval' }
  // Paused comes first: the question under the paused view is not on screen.
  if (screen?.paused) return { kind: 'approval', word: 'Paused' }
  if (screen?.asking) return { kind: 'approval', word: 'Waiting for your answer' }
  // While the assistant talks or hears the user, that is what counts.
  if (screen && state.activity !== 'speaking' && state.activity !== 'hearing') {
    return { kind: 'looking', word: 'Working on the screen', detail: screen.step ?? undefined }
  }
  switch (state.activity) {
    case 'hearing':
      return { kind: null, word: 'Listening' }
    case 'thinking':
      return { kind: 'thinking', word: 'Thinking' }
    case 'speaking':
      return { kind: null, word: 'Speaking' }
    case 'tool':
      return state.runningTool ? toolFace(state.runningTool) : { kind: 'tool', word: 'Using tool' }
    case 'listening':
      return { kind: null, word: state.muted ? 'Microphone muted' : 'Listening' }
  }
}

/** The status as one line of text. */
export function voiceStatusText(status: VoiceStatus): string {
  return status.detail ? `${status.word}: ${status.detail}` : status.word
}
