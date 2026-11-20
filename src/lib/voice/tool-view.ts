// How a tool call reads on the Voice surface: exactly as in the chat.
//
// The transcript of a voice session shows its tool calls with the chat's own
// components (ToolCallBand, ToolCallBlock). This file hands them what they
// expect: the call in the chat's shape, and the calls in the order of the
// conversation. No React.

import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from '../computer/prompt'
import type { AgentToolCall, ToolCallStatus } from '../../types/agent-mode'
import type { VoiceLine, VoiceToolLine } from './session-state'

const STATUS: Record<VoiceToolLine['status'], ToolCallStatus> = {
  waiting: 'pending_approval',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  rejected: 'rejected',
}

// The chat's block is memoised on the identity of its call, and the session
// state replaces a tool line only when it changes. One chat call per line
// keeps a block still while the words of the answer stream in around it.
const calls = new WeakMap<VoiceToolLine, AgentToolCall>()

/** A tool call of the session in the shape the chat's components take. */
export function voiceToolCall(tool: VoiceToolLine): AgentToolCall {
  let call = calls.get(tool)
  if (!call) {
    call = {
      id: tool.id,
      toolName: tool.name,
      args: tool.args,
      status: STATUS[tool.status],
      // As the chat keeps it: an answer is a result, anything else an error.
      ...(tool.status === 'completed' ? { result: tool.result } : { error: tool.result }),
      duration: tool.durationMs || undefined,
      timestamp: 0,
    }
    calls.set(tool, call)
  }
  return call
}

export type VoiceTimelineItem =
  | { kind: 'line'; key: string; line: VoiceLine }
  | { kind: 'tools'; key: string; calls: AgentToolCall[] }

/** A call of computer control: what LU saw hangs on its block. */
function onTheScreen(tool: VoiceToolLine): boolean {
  return tool.name === COMPUTER_TASK_TOOL_NAME || tool.name === COMPUTER_USE_TOOL_NAME
}

/**
 * What was said and what was done, in the order it happened: every tool call
 * sits after the line it followed. Calls whose line is no longer kept come
 * first.
 *
 * Calls in a row are one band, as in the chat, and a finished band folds to
 * "N steps". A call of computer control is always a band of its own, so the
 * pictures of what LU saw never fold away with it.
 */
export function voiceTimeline(lines: readonly VoiceLine[], tools: readonly VoiceToolLine[]): VoiceTimelineItem[] {
  const known = new Set(lines.map((line) => line.id))
  const groups = new Map<number, VoiceToolLine[]>()
  for (const tool of tools) {
    const at = known.has(tool.after) ? tool.after : 0
    groups.set(at, [...(groups.get(at) ?? []), tool])
  }
  const items: VoiceTimelineItem[] = []
  const bands = (at: number) => {
    let band: VoiceToolLine[] = []
    const flush = () => {
      if (band.length === 0) return
      items.push({ kind: 'tools', key: `tools-${band[0].id}`, calls: band.map(voiceToolCall) })
      band = []
    }
    for (const tool of groups.get(at) ?? []) {
      if (onTheScreen(tool)) {
        flush()
        band = [tool]
        flush()
      } else {
        band.push(tool)
      }
    }
    flush()
  }
  bands(0)
  for (const line of lines) {
    items.push({ kind: 'line', key: `line-${line.id}`, line })
    bands(line.id)
  }
  return items
}
