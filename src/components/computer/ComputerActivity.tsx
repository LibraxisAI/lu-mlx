import { useMemo } from 'react'
import { ToolCallBand } from '../chat/ToolCallBand'
import { ThinkingBlock } from '../chat/ThinkingBlock'
import { getBlockToolCalls } from '../../api/agents/block-helpers'
import { computerRunOrigin } from '../../api/computer-use'
import { voiceTimeline } from '../../lib/voice/tool-view'
import { VoiceThought } from '../voice/VoiceThought'
import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from '../../lib/computer/prompt'
import { useChatStore } from '../../stores/chatStore'
import { useComputerStore } from '../../stores/computerStore'
import { useVoiceSessionStore } from '../../stores/voiceSessionStore'
import type { ComputerTask } from '../../stores/computerStore'
import type { AgentBlock, AgentToolCall } from '../../types/agent-mode'
import type { VoiceLine, VoiceToolLine } from '../../lib/voice/session-state'

const hintCls = 't-micro leading-relaxed text-gray-500 dark:text-gray-400'

const PHASE_TEXT: Record<ComputerTask['phase'], string> = {
  looking: 'Looking at the screen',
  deciding: 'Choosing the next step',
  acting: 'Acting',
}

/** The step of the running screen task, in a few words. */
export function taskStepText(task: ComputerTask): string {
  const last = task.steps[task.steps.length - 1]
  if (last) return `Step ${task.steps.length}: ${last.label}${last.ok === false ? ' (did not work)' : ''}`
  return task.blind && task.phase === 'looking' ? 'Reading the window' : PHASE_TEXT[task.phase]
}

/** The running screen task: its goal, where it is, and the last step. */
export function TaskProgress({ task }: { task: ComputerTask }) {
  const last = task.steps[task.steps.length - 1]
  const count = task.steps.length
  return (
    <div data-testid="computer-task-progress">
      <p className="t-micro text-gray-600 truncate" title={task.goal}>
        Task: {task.goal}
      </p>
      <p className={hintCls}>
        <span data-testid="computer-task-step">
          {count > 0 ? `Step ${count} of at most ${task.maxSteps}` : `At most ${task.maxSteps} steps`}
          {last ? `: ${last.label}` : ''}
          {last && last.ok === false ? ' (did not work)' : ''}
        </span>
        {' · '}{task.blind && task.phase === 'looking' ? 'Reading the window' : PHASE_TEXT[task.phase]} with {task.modelLabel}
      </p>
    </div>
  )
}

const onTheScreen = (call: AgentToolCall): boolean => call.toolName === COMPUTER_TASK_TOOL_NAME || call.toolName === COMPUTER_USE_TOOL_NAME

/** One entry of what the run did: a band of tool calls, a thought of the model, or what it wrote. */
export type ActivityItem =
  | { kind: 'tools'; key: string; calls: AgentToolCall[] }
  /** A thought of the model of a voice session. */
  | { kind: 'thought'; key: string; line: VoiceLine }
  /** A thought of the model of a chat. */
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }

/**
 * What an answer of the chat did, in the order it happened: its thoughts,
 * its tool calls and what it wrote between them. Calls in a row are one
 * band, as in the chat. A call of computer control is a band of its own, so
 * the pictures of what LU saw never fold away with it.
 */
export function chatActivity(blocks: readonly AgentBlock[]): ActivityItem[] {
  const items: ActivityItem[] = []
  let open: AgentToolCall[] = []
  const close = () => {
    if (open.length > 0) items.push({ kind: 'tools', key: open[0].id, calls: open })
    open = []
  }
  for (const block of blocks) {
    const calls = getBlockToolCalls(block)
    if (calls.length > 0) {
      for (const call of calls) {
        if (onTheScreen(call)) {
          close()
          items.push({ kind: 'tools', key: call.id, calls: [call] })
        } else open.push(call)
      }
      continue
    }
    const text = block.content.trim()
    if (!text) continue
    close()
    items.push(block.phase === 'thinking' ? { kind: 'thinking', key: block.id, text } : { kind: 'text', key: block.id, text })
  }
  close()
  return items
}

/**
 * What a voice session did, in order: its tool calls and the thoughts of its
 * model. What was said aloud is the transcript's and stays there.
 */
export function voiceActivity(lines: readonly VoiceLine[], tools: readonly VoiceToolLine[]): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const item of voiceTimeline(lines, tools)) {
    if (item.kind === 'tools') items.push(item)
    else if (item.line.role === 'thought') items.push({ kind: 'thought', key: item.key, line: item.line })
  }
  return items
}

/** What the run that uses the screen did: the voice session, or the latest answer of its chat. */
function useRunActivity(): ActivityItem[] {
  // Read again whenever computer control moves on.
  const working = useComputerStore((s) => s.working)
  const task = useComputerStore((s) => s.task)
  const voiceLines = useVoiceSessionStore((s) => s.lines)
  const voiceTools = useVoiceSessionStore((s) => s.tools)
  const conversations = useChatStore((s) => s.conversations)
  return useMemo(() => {
    void working
    void task
    const origin = computerRunOrigin()
    if (origin.voice) return voiceActivity(voiceLines, voiceTools)
    const conversation = conversations.find((c) => c.id === origin.conversationId)
    const answer = conversation ? [...conversation.messages].reverse().find((m) => m.role === 'assistant') : undefined
    return chatActivity(answer?.agentBlocks ?? [])
  }, [working, task, voiceLines, voiceTools, conversations])
}

/**
 * What the model is doing, with the chat's own building blocks: the band of
 * tool calls and, on a call of computer control, the small pictures of what
 * LU saw. The thoughts of the model stand between them, folded, as in the
 * chat and in the transcript, and so does what it wrote. Shown in the panel
 * and in the paused view.
 */
export function ComputerActivity({ className = '' }: { className?: string }) {
  const task = useComputerStore((s) => s.task)
  const notice = useComputerStore((s) => s.notice)
  const items = useRunActivity()
  return (
    <div className={`space-y-2 ${className}`} data-testid="computer-activity">
      {task && <TaskProgress task={task} />}
      {items.length === 0 && !task && <p className={hintCls}>Nothing was done on the screen yet.</p>}
      {items.map((item) => item.kind === 'thought' ? (
        <div key={item.key} data-role="thought">
          <VoiceThought line={item.line} />
        </div>
      ) : item.kind === 'thinking' ? (
        <div key={item.key} data-role="thought">
          <ThinkingBlock thinking={item.text} />
        </div>
      ) : item.kind === 'text' ? (
        <p key={item.key} data-role="text" className="t-micro leading-relaxed text-gray-600 whitespace-pre-wrap break-words">{item.text}</p>
      ) : (
        <div key={item.key} role="group" aria-label="Tools">
          <ToolCallBand calls={item.calls} />
        </div>
      ))}
      {notice && <p className={hintCls} data-testid="computer-notice">{notice}</p>}
    </div>
  )
}
