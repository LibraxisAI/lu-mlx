/**
 * Bug hunt 01.10.2026 (A8). A background sub-agent asks for approval in the
 * same per-conversation queue as the run that started it, but it outlives that
 * run. The run's end emptied the whole queue, so the sub-agent was told "User
 * rejected tool call" for a question the user never saw.
 */
import { it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { enqueueApproval, drainApprovals, headApproval, resetApprovals, type ApprovalEntry } from '../approval-queue'
import type { AgentToolCall } from '../../types/agent-mode'

const call = (id: string): AgentToolCall => ({ id, toolName: 'shell_execute', args: {}, status: 'pending_approval', timestamp: 0 })

beforeEach(() => resetApprovals())

it('the run end answers its own questions and leaves the sub-agent waiting', () => {
  const run = new AbortController().signal
  const background = new AbortController().signal
  const answers: Record<string, boolean> = {}
  const entry = (id: string, owner: AbortSignal): ApprovalEntry => ({ toolCall: call(id), owner, resolve: (a) => { answers[id] = a } })
  enqueueApproval('c1', entry('main', run))
  enqueueApproval('c1', entry('sub', background))

  drainApprovals('c1', run)
  expect(answers).toEqual({ main: false })
  expect(headApproval('c1')?.id).toBe('sub')

  // Stop still clears everything in the conversation.
  drainApprovals('c1')
  expect(answers).toEqual({ main: false, sub: false })
  expect(headApproval('c1')).toBeNull()
})

it('both askers say who they are, and the run end passes its own signal', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '..', '..', f), 'utf8')
  expect(read('hooks/useAgentChat.ts')).toContain('const entry: ApprovalEntry = { toolCall, resolve, owner: signal }')
  expect(read('hooks/useAgentChat.ts')).toContain('drainApprovals(convId, abort.signal)')
  expect(read('api/agents/sub-agent.ts')).toContain('const entry: ApprovalEntry = { toolCall, resolve, owner: abortSignal }')
})
