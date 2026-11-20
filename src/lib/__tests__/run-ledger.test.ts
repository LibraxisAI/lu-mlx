/**
 * The run ledger: a trimmed run still knows what it already did (customer
 * case 30.09.2026, "always starting with the beginning", see runLedger).
 *
 * Run: npx vitest run src/lib/__tests__/run-ledger.test.ts
 */
import { describe, it, expect } from 'vitest'
import { runLedger, trimWorkingHistory, LEDGER_MAX_LINES, type DecayMessage } from '../context-decay'

const call = (id: string, name: string, args: Record<string, unknown>): DecayMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, function: { name, arguments: args } }],
})
const result = (id: string, chars: number): DecayMessage => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(chars) })

describe('runLedger', () => {
  it('lists what the dropped part did, oldest first, duplicates folded', () => {
    const ledger = runLedger([
      call('1', 'file_read', { path: 'src/a.ts' }), result('1', 10),
      call('2', 'file_edit', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }), result('2', 10),
      call('3', 'file_read', { path: 'src/a.ts' }), result('3', 10),
      call('4', 'shell_execute', { command: 'npm   test' }), result('4', 10),
    ])!
    expect(ledger.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- file_read: src/a.ts',
      '- file_edit: src/a.ts',
      '- shell_execute: npm test',
    ])
  })

  it('reads JSON-string arguments too, and skips plan bookkeeping', () => {
    const ledger = runLedger([
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'file_search', arguments: '{"pattern":"TODO"}' } }] },
      call('b', 'todo_write', { todos: [] }),
    ])!
    expect(ledger).toContain('- file_search: TODO')
    expect(ledger).not.toContain('todo_write')
  })

  it('says nothing when nothing was done', () => {
    expect(runLedger([{ role: 'user', content: 'hi' }])).toBeNull()
  })

  it('keeps the newest lines when there are too many', () => {
    const many = Array.from({ length: LEDGER_MAX_LINES + 5 }, (_, i) => call(String(i), 'file_read', { path: `f${i}.ts` }))
    const lines = runLedger(many)!.split('\n')
    expect(lines).toContain('- (5 older steps)')
    expect(lines).toContain(`- file_read: f${LEDGER_MAX_LINES + 4}.ts`)
    expect(lines).not.toContain('- file_read: f0.ts')
  })
})

describe('trimWorkingHistory carries the ledger on the pinned task', () => {
  const history = (): DecayMessage[] => {
    const out: DecayMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'refactor the parser' }]
    for (let i = 0; i < 40; i++) out.push(call(String(i), 'file_read', { path: `src/f${i}.ts` }), result(String(i), 3000))
    return out
  }

  it('the task stays first and names the dropped work', () => {
    const { messages, dropped } = trimWorkingHistory(history(), 8000, { enabled: false })
    expect(dropped).toBeGreaterThan(0)
    expect(messages[1].role).toBe('user')
    const task = messages[1].content as string
    expect(task.startsWith('refactor the parser\n\n[Run ledger]')).toBe(true)
    expect(task).toContain('- file_read: src/f0.ts')
    // No two user messages in a row.
    expect(messages[2].role).not.toBe('user')
  })

  it('is stable between trims: the same drop point yields the same bytes', () => {
    const a = trimWorkingHistory(history(), 8000, { enabled: false })
    const b = trimWorkingHistory(history(), 8000, { enabled: false })
    expect(a.messages[1].content).toBe(b.messages[1].content)
  })

  it('leaves an untrimmed history alone', () => {
    const small = history().slice(0, 4)
    expect(trimWorkingHistory(small, 64000).messages).toBe(small)
  })
})
