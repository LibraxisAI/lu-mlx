import { ThinkingBlock } from '../chat/ThinkingBlock'
import type { VoiceLine } from '../../lib/voice/session-state'

/** The header of a finished thought: how long it took, and whether it was ended early. */
export function thoughtLabel(line: Pick<VoiceLine, 'secs' | 'cut'>): string {
  const secs = line.secs === undefined ? null : Math.max(1, Math.round(line.secs))
  const took = secs === null ? 'Thought' : `Thought for ${secs} s`
  return line.cut ? `${took}, ended at the length set in the Voice settings` : took
}

/**
 * A thought of the model in a voice session: the chat's own block, folded,
 * with how long the thought took. The same in the transcript and wherever
 * else the session is shown (the paused view of computer control).
 */
export function VoiceThought({ line }: { line: VoiceLine }) {
  return <ThinkingBlock thinking={line.text} streaming={!line.final} label={thoughtLabel(line)} />
}
