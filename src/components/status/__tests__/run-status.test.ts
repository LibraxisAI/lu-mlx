/**
 * Which state a run shows, from what the stores hold.
 *
 * Run: npx vitest run src/components/status/__tests__/run-status.test.ts
 */
import { describe, it, expect } from 'vitest'
import { askingWord, deriveRunStatus, toolFace } from '../run-status'
import { MOTIFS } from '../glyph-motifs'
import type { AgentBlock, AgentToolCall } from '../../../types/agent-mode'

const call = (toolName: string, status: string): AgentToolCall =>
  ({ id: toolName, toolName, args: {}, status } as unknown as AgentToolCall)
const block = (...toolCalls: AgentToolCall[]): AgentBlock =>
  ({ id: 'b', phase: 'acting', content: '', toolCalls, timestamp: 0 } as unknown as AgentBlock)

describe('the order of urgency', () => {
  const everything = {
    awaitingApproval: true,
    loadingModel: true,
    activity: { label: 'Writing file', detail: 'a.ts' },
    message: { content: 'text', thinking: 'hm', agentBlocks: [block(call('file_read', 'running'))] },
  }

  it('a wait for the user beats everything', () => {
    expect(deriveRunStatus(everything)).toEqual({ kind: 'approval', word: 'Waiting for your approval' })
  })

  it('then a loading model', () => {
    expect(deriveRunStatus({ ...everything, awaitingApproval: false }).kind).toBe('loading')
  })

  it('then the call the model is still writing, with its label and detail', () => {
    expect(deriveRunStatus({ ...everything, awaitingApproval: false, loadingModel: false })).toEqual({
      kind: 'preparing', word: 'Writing file', detail: 'a.ts',
    })
  })

  it('then the tool that runs', () => {
    expect(deriveRunStatus({ message: everything.message })).toEqual({ kind: 'reading', word: 'Reading' })
  })
})

describe('what streams', () => {
  it('reasoning without an answer is Thinking', () => {
    expect(deriveRunStatus({ message: { thinking: 'hm', content: '  ' } }).word).toBe('Thinking')
  })

  it('an answer is Responding, also when it had reasoning before', () => {
    expect(deriveRunStatus({ message: { thinking: 'hm', content: 'Hi' } }).word).toBe('Responding')
  })

  it('an empty answer is the start of the run', () => {
    expect(deriveRunStatus({ message: { content: '' } })).toEqual({ kind: 'starting', word: 'Starting' })
  })

  it('a gap between two steps of an agent run is Working', () => {
    const done = { content: '', agentBlocks: [block(call('file_read', 'completed'))] }
    expect(deriveRunStatus({ message: done })).toEqual({ kind: 'working', word: 'Working' })
  })

  it('a surface that knows nothing says Working', () => {
    expect(deriveRunStatus({})).toEqual({ kind: 'working', word: 'Working' })
  })
})

describe('the face of a tool', () => {
  it.each([
    ['file_read', 'Reading'], ['file_edit', 'Writing'], ['shell_execute', 'Running'], ['web_search', 'Searching'],
    ['screenshot', 'Looking'], ['image_generate', 'Creating'], ['delegate_task', 'Delegating'],
  ])('%s shows %s', (name, word) => {
    expect(toolFace(name).word).toBe(word)
  })

  it.each([
    ['file_read', 'read files'], ['file_write', 'change a file'], ['file_edit', 'change a file'], ['shell_execute', 'run a command'],
    ['web_fetch', 'use the web'], ['computer_task', 'work on the screen'], ['image_generate', 'create a picture or a video'],
    ['mcp__notes__add', 'use a tool'],
  ])('the question before %s says "wants to %s", never the name', (name, words) => {
    expect(askingWord(name)).toBe(words)
    expect(askingWord(name)).not.toMatch(/[_–—]/)
  })

  it('a tool nobody listed, an MCP tool for one, gets the generic face', () => {
    expect(toolFace('mcp__notes__add')).toEqual({ kind: 'tool', word: 'Using tool' })
  })

  it('the first running call wins, finished ones do not count', () => {
    const blocks = [block(call('web_search', 'completed')), block(call('file_write', 'running'), call('shell_execute', 'running'))]
    expect(deriveRunStatus({ message: { agentBlocks: blocks } }).word).toBe('Writing')
  })

  it('the legacy single call shape is read too', () => {
    const legacy = { id: 'b', phase: 'acting', content: '', toolCall: call('web_fetch', 'running'), timestamp: 0 } as unknown as AgentBlock
    expect(deriveRunStatus({ message: { agentBlocks: [legacy] } }).word).toBe('Searching')
  })

  it('computer control has its own face, in the chat as in voice', () => {
    expect(toolFace('computer_task')).toEqual({ kind: 'looking', word: 'Working on the screen' })
    expect(toolFace('computer_use', { action: 'click', x: 1, y: 2 })).toEqual({ kind: 'looking', word: 'Working on the screen' })
    expect(toolFace('computer_use', { action: 'screenshot' })).toEqual({ kind: 'looking', word: 'Looking' })
    expect(toolFace('computer_use', { action: 'read_tree' })).toEqual({ kind: 'looking', word: 'Looking' })
    expect(toolFace('computer_use')).toEqual({ kind: 'looking', word: 'Working on the screen' })
  })

  it('a summary of the context and a wait before a retry show as their own states', () => {
    expect(deriveRunStatus({ activity: { label: 'Compacting', kind: 'compacting' }, message: { content: 'x' } })).toMatchObject({ kind: 'compacting', word: 'Compacting' })
    expect(deriveRunStatus({ activity: { label: 'Retrying', kind: 'retrying' } })).toMatchObject({ kind: 'retrying', word: 'Retrying' })
    // A wait for the user still comes first.
    expect(deriveRunStatus({ awaitingApproval: true, activity: { label: 'Retrying', kind: 'retrying' } }).kind).toBe('approval')
    expect(MOTIFS.compacting).toBeDefined()
    expect(MOTIFS.retrying).toBeDefined()
  })

  it('every state it can return has a motif, and no word carries a dash', () => {
    const seen = [
      deriveRunStatus({ awaitingApproval: true }), deriveRunStatus({ loadingModel: true }),
      deriveRunStatus({ activity: { label: 'Writing file' } }), deriveRunStatus({ message: { thinking: 'x' } }),
      deriveRunStatus({ message: { content: 'x' } }), deriveRunStatus({ message: {} }), deriveRunStatus({}),
      ...['file_read', 'file_write', 'shell_execute', 'web_search', 'screenshot', 'image_generate', 'delegate_task', 'computer_use', 'computer_task', 'x'].map((name) => toolFace(name)),
    ]
    for (const s of seen) {
      expect(MOTIFS[s.kind]).toBeDefined()
      expect(s.word).not.toMatch(/[–—]/)
    }
  })
})

describe('a call the model is still writing', () => {
  it('is named in words from the same table as the running tool, never by its internal name', async () => {
    const { preparingWord } = await import('../run-status')
    const { toolProgressActivity } = await import('../../../stores/runActivityStore')
    expect(preparingWord('web_search')).toBe('Preparing to search')
    expect(preparingWord('file_write')).toBe('Preparing to write')
    expect(preparingWord('shell_execute')).toBe('Preparing to run')
    expect(preparingWord('computer_task')).toBe('Preparing to work on the screen')
    expect(preparingWord('image_generate')).toBe('Preparing to create')
    expect(preparingWord('delegate_task')).toBe('Preparing to delegate')
    // A tool without a face of its own, also one a plugin brought.
    expect(preparingWord('todo_write')).toBe('Preparing a tool')
    expect(preparingWord('mcp__some_server__do_thing')).toBe('Preparing a tool')
    expect(toolProgressActivity({ name: 'web_search', argsChars: 10 })).toEqual({ label: 'Preparing to search' })
    expect(toolProgressActivity({ name: 'file_write', argsChars: 4100 })).toEqual({ label: 'Preparing to write', detail: '4 kB' })
  })

  it('holds for every tool the app ships', async () => {
    const { preparingWord } = await import('../run-status')
    const { toolRegistry } = await import('../../../api/mcp')
    const names = toolRegistry.getAll().map((tool) => tool.name)
    expect(names.length).toBeGreaterThan(10)
    for (const name of [...names, 'computer_use', 'computer_task']) {
      const label = preparingWord(name)
      expect(label, name).toMatch(/^Preparing (to [a-z ]+|a tool)$/)
      expect(label, name).not.toContain('_')
    }
  })
})
