import { describe, it, expect, beforeEach } from 'vitest'
import { makeInTurnCacheLookup } from '../in-turn-cache'
import { useToolAuditStore } from '../../../stores/toolAuditStore'
import { stableArgsHash } from '../block-helpers'
import { toolRegistry } from '../../mcp/tool-registry'

/**
 * Bug hunt 01.10.2026, A5: tools report most failures as text with status
 * 'completed'. The in-turn cache kept such a failure as a hit, so a retry in
 * the same turn got the old error back and the call never ran again.
 */

function prior(toolName: string, args: Record<string, unknown>, result: string): void {
  const s = useToolAuditStore.getState()
  const id = s.record({ convId: 'c1', toolCallId: `p-${toolName}`, toolName, args, startedAt: 1000 })
  s.complete(id, { status: 'completed', completedAt: 1100, resultPreview: result })
}

describe('the in-turn cache does not serve a failure', () => {
  beforeEach(() => useToolAuditStore.getState().clearAll())

  it('a failed web_fetch runs again on the retry', () => {
    const args = { url: 'https://example.com' }
    prior('web_fetch', args, 'Error: fetch timed out after 30s')
    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup({ id: 'n', toolName: 'web_fetch', args }, stableArgsHash(args))).toBeUndefined()
  })

  it('a successful web_fetch is still served from the cache', () => {
    const args = { url: 'https://example.com' }
    prior('web_fetch', args, '<h1>Example Domain</h1>')
    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    expect(lookup({ id: 'n', toolName: 'web_fetch', args }, stableArgsHash(args))).toBe('<h1>Example Domain</h1>')
  })

  it('a look at the screen or a step on it is never served from the cache', () => {
    // Box, 09.10.2026: 97 of 101 calls of computer_use came back in 0 ms with
    // the picture and the sentence of the first ones. No window moved.
    for (const args of [{ action: 'screenshot' }, { action: 'focus_window', window_id: 7 }]) {
      prior('computer_use', args, 'Screenshot (screen frame 1): 1568x882 pixels of display 1.')
      const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
      expect(lookup({ id: 'n', toolName: 'computer_use', args }, stableArgsHash(args))).toBeUndefined()
    }
    const goal = { goal: 'Click Count' }
    prior('computer_task', goal, 'The screen task is finished.')
    expect(makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })({ id: 'n', toolName: 'computer_task', args: goal }, stableArgsHash(goal))).toBeUndefined()
  })

  it('the state of the background agents and a message to one of them are never served from the cache', () => {
    const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
    prior('check_tasks', {}, 'task 1: running')
    expect(lookup({ id: 'n', toolName: 'check_tasks', args: {} }, stableArgsHash({}))).toBeUndefined()
    const note = { task_id: '1', message: 'go on' }
    prior('message_agent', note, 'Delivered.')
    expect(lookup({ id: 'n', toolName: 'message_agent', args: note }, stableArgsHash(note))).toBeUndefined()
  })

  it('a tool of a connected server is never served from the cache, a built-in reader of the same shape is', () => {
    const args = { id: 7 }
    toolRegistry.registerExternal('probe-server', [{ name: 'door_open', description: 'Opens the door.', inputSchema: { type: 'object', properties: {} }, category: 'system' } as never], async () => 'opened')
    try {
      prior('door_open', args, 'opened')
      prior('weather', args, 'sunny')
      const lookup = makeInTurnCacheLookup({ convId: 'c1', turnStartMs: 500 })
      expect(lookup({ id: 'n', toolName: 'door_open', args }, stableArgsHash(args))).toBeUndefined()
      expect(lookup({ id: 'n', toolName: 'weather', args }, stableArgsHash(args))).toBe('sunny')
    } finally {
      toolRegistry.unregisterServer('probe-server')
    }
  })
})
