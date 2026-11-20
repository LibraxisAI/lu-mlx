/**
 * GH #147 (LU Cloud, Windows Code agent, 2026-10-01). The screenshots show two
 * call shapes the agent could not run, so the model kept "correcting" and the
 * task never moved:
 *   - text   !function_call:{"call": "file_list", "arguments": {...}}
 *   - native a call NAMED "function", with {"todos": [...]} or {"path": "."}
 *            as arguments, answered "Unknown tool: function" every time
 *
 * Run: npx vitest run src/lib/__tests__/a-call-named-function-reaches-its-tool.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { parseLooseToolCalls, stripMatchedCalls, repairToolCall, isGenericCallName } from '../loose-tool-parse'
import { toolRegistry } from '../../api/mcp/tool-registry'
import { registerBuiltinTools } from '../../api/mcp/builtin-tools'

let tools: ReturnType<typeof toolRegistry.getAll>
beforeAll(() => {
  registerBuiltinTools(toolRegistry)
  tools = toolRegistry.getAll()
})
const names = () => tools.map((t) => t.name)

describe('the "call" spelling written as text', () => {
  const text = 'We\'ll proceed.\n\n!function_call:{"call": "file_list", "arguments": {"path": "core\\\\mesh", "pattern": "init.py"}}\n!function_call:{"call": "file_read", "arguments": {"path": "core\\\\verifier.py"}} !function_call:{"call": "file_read", "arguments": {"path": "core\\\\mesh\\\\worker.py"}}'

  it('becomes three real calls', () => {
    const r = parseLooseToolCalls(text, names())
    expect(r.calls.map((c) => c.name)).toEqual(['file_list', 'file_read', 'file_read'])
    expect(r.calls[0].arguments).toEqual({ path: 'core\\mesh', pattern: 'init.py' })
    expect(r.calls[2].arguments).toEqual({ path: 'core\\mesh\\worker.py' })
  })

  it('leaves no call text in the answer', () => {
    const r = parseLooseToolCalls(text, names())
    expect(stripMatchedCalls(text, r.matched)).toBe("We'll proceed.")
  })

  // Negative control: an unknown name in the same shape stays prose.
  it('a name that is no tool is not lifted', () => {
    expect(parseLooseToolCalls('!function_call:{"call": "delete_everything", "arguments": {}}', names()).calls).toEqual([])
  })
})

describe('a native call named "function"', () => {
  it('with a todo list goes to todo_write', () => {
    const todos = [{ content: 'List root directory', status: 'in_progress' }]
    expect(repairToolCall('function', { todos }, tools)).toEqual({ name: 'todo_write', arguments: { todos } })
  })

  it('that names its tool inside goes to that tool', () => {
    expect(repairToolCall('function', { name: 'file_read', arguments: { path: 'a.py' } }, tools))
      .toEqual({ name: 'file_read', arguments: { path: 'a.py' } })
    expect(repairToolCall('tool', { tool: 'file_list', path: '.' }, tools))
      .toEqual({ name: 'file_list', arguments: { path: '.' } })
  })

  // {"path": "."} fits more than one tool: guessing could read a file the
  // model never asked for, so the call stays and the error says what to send.
  it('that fits several tools stays as sent', () => {
    expect(repairToolCall('function', { path: '.' }, tools).name).toBe('function')
    expect(isGenericCallName('function')).toBe(true)
  })

  it('a real tool name keeps the old repair, a real unknown stays unknown', () => {
    expect(repairToolCall('read_file', { path: 'a' }, tools).name).toBe('file_read')
    expect(repairToolCall('explain_phenomenon', { topic: 'sky' }, tools).name).toBe('explain_phenomenon')
    expect(isGenericCallName('file_read')).toBe(false)
  })
})
