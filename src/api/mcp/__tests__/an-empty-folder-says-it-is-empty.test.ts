/**
 * 3.0.4 box run: file_list on a fresh workspace returned an empty string. The
 * model said "I listed the files" and named none, the opened step showed no
 * result. An empty listing and an empty search now say so.
 *
 * Run: npx vitest run src/api/mcp/__tests__/an-empty-folder-says-it-is-empty.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

let answer: unknown = {}
vi.mock('../../backend', () => ({
  backendCall: vi.fn(async () => answer),
  fetchExternal: vi.fn(),
}))
vi.mock('../../agents/sub-agent', () => ({
  DELEGATE_TASK_TOOL_DEF: { name: 'delegate_task', description: '', category: 'system', inputSchema: {} },
  buildDelegateExecutor: () => async () => 'stub',
}))
vi.mock('../../../lib/workflow-engine', () => ({ WorkflowEngine: class {} }))

import { registerBuiltinTools } from '../builtin-tools'
import { ToolRegistry } from '../tool-registry'

const registry = new ToolRegistry()
registerBuiltinTools(registry)

describe('empty answers are named', () => {
  it('file_list of an empty folder', async () => {
    answer = { entries: [], count: 0 }
    expect(await registry.execute('file_list', { path: './.' })).toBe('The folder is empty.')
  })

  it('file_search without a match', async () => {
    answer = { results: [], count: 0 }
    expect(await registry.execute('file_search', { path: '.', pattern: 'x' })).toBe('No matches.')
  })

  it('NEGATIVE CONTROL: a folder with a file still lists it', async () => {
    answer = { entries: [{ name: 'hello.txt', path: '/ws/hello.txt', size: 2, isDir: false }], count: 1 }
    expect(await registry.execute('file_list', { path: '.' })).toContain('hello.txt')
  })
})
