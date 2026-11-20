/**
 * 3.0.4 box run (Gegenprobe 4): the Agent asked to write
 * C:\Users\user\Desktop\poem.txt, the user approved, and the call failed right
 * after with "Path escapes the allowed workspace". A card for a call the guard
 * refuses anyway is a question without a choice. Same for plain-chat artifact
 * mode, where file_write never touches the disk.
 *
 * Run: npx vitest run src/api/mcp/__tests__/no-card-for-a-call-that-cannot-run.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const calls: { cmd: string; body: Record<string, unknown> }[] = []
let fsInfo: () => unknown = () => ({ isDir: false })

vi.mock('../../backend', () => ({
  backendCall: vi.fn(async (cmd: string, body: Record<string, unknown>) => {
    calls.push({ cmd, body })
    if (cmd === 'fs_info') return fsInfo()
    return { ok: true }
  }),
  fetchExternal: vi.fn(),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { approvalIsMoot } from '../builtin-tools'
import { beginAgentRun, endAgentRun } from '../../agent-context'

const escapes = () => { throw new Error('Path escapes the allowed workspace') }

beforeEach(() => {
  calls.length = 0
  fsInfo = () => ({ isDir: false })
})

describe('a call the workspace guard refuses gets no card', () => {
  it('file_write outside the folder: no card, and the check went through the guard with this chat', async () => {
    fsInfo = escapes
    const run = beginAgentRun({ chatId: 'chat-1', conversationId: 'c1' })
    try {
      expect(await approvalIsMoot('file_write', { path: 'C:\\Users\\user\\Desktop\\poem.txt', content: 'x' }, run)).toBe(true)
      expect(calls).toEqual([{ cmd: 'fs_info', body: { path: 'C:\\Users\\user\\Desktop\\poem.txt', chatId: 'chat-1' } }])
    } finally { endAgentRun(run) }
  })

  it('NEGATIVE CONTROL: a path inside the folder keeps its card, existing or not', async () => {
    const run = beginAgentRun({ chatId: 'chat-1', conversationId: 'c1' })
    try {
      expect(await approvalIsMoot('file_write', { path: 'poem.txt', content: 'x' }, run)).toBe(false)
      fsInfo = () => { throw new Error('Path not found: /ws/poem.txt') }
      expect(await approvalIsMoot('file_write', { path: 'poem.txt', content: 'x' }, run)).toBe(false)
      fsInfo = () => { throw new Error('backend offline') }
      expect(await approvalIsMoot('file_edit', { path: 'a.ts' }, run)).toBe(false)
    } finally { endAgentRun(run) }
  })

  it('tools without a workspace path are never checked', async () => {
    fsInfo = escapes
    expect(await approvalIsMoot('shell_execute', { command: 'rm -rf /' })).toBe(false)
    expect(await approvalIsMoot('web_fetch', { url: 'https://x' })).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('plain-chat artifact mode', () => {
  it('file_write there only shows a preview, so there is nothing to approve', async () => {
    const run = beginAgentRun({ chatId: 'chat-2', conversationId: 'c2', artifactMode: true })
    try {
      expect(await approvalIsMoot('file_write', { path: 'notes.md', content: 'x' }, run)).toBe(true)
      expect(calls).toEqual([])
    } finally { endAgentRun(run) }
  })
})

describe('wiring', () => {
  it('useAgentChat asks approvalIsMoot before it puts a card up', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const agent = readFileSync(resolve(here, '../../../hooks/useAgentChat.ts'), 'utf8')
    expect(agent).toContain("&& !(await approvalIsMoot(tc.function.name, tc.function.arguments ?? {}, run))")
  })
})
