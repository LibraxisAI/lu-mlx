import { describe, expect, it } from 'vitest'
import { voiceTimeline, voiceToolCall } from '../tool-view'
import type { VoiceLine, VoiceToolLine } from '../session-state'

const tool = (patch: Partial<VoiceToolLine>): VoiceToolLine => ({ id: 'c1', name: 'file_write', status: 'completed', args: {}, after: 0, ...patch })
const line = (id: number, role: VoiceLine['role']): VoiceLine => ({ id, role, text: `line ${id}`, final: true })
const ids = (items: ReturnType<typeof voiceTimeline>) => items.map((item) => item.kind === 'line' ? item.line.id : item.calls.map((c) => c.id).join('+'))

describe('voiceToolCall', () => {
  it('hands the chat its own shape: name, arguments, status, time', () => {
    const args = { path: 'shopping.txt', content: 'milk' }
    expect(voiceToolCall(tool({ args, result: 'Wrote shopping.txt', durationMs: 42 }))).toEqual({
      id: 'c1', toolName: 'file_write', args, status: 'completed', result: 'Wrote shopping.txt', duration: 42, timestamp: 0,
    })
  })

  it('every state of a voice call has its chat state', () => {
    const states = (['waiting', 'running', 'completed', 'failed', 'rejected'] as const).map((status) => voiceToolCall(tool({ status })).status)
    expect(states).toEqual(['pending_approval', 'running', 'completed', 'failed', 'rejected'])
  })

  it('what a failed call answered is its error, as the chat keeps it', () => {
    const call = voiceToolCall(tool({ status: 'failed', result: 'timed out' }))
    expect(call.error).toBe('timed out')
    expect(call.result).toBeUndefined()
  })

  it('a call that never ran shows no time', () => {
    expect(voiceToolCall(tool({ status: 'rejected', durationMs: 0 })).duration).toBeUndefined()
  })

  it('the same line gives the same call, so a block stays still while the answer streams', () => {
    const one = tool({})
    expect(voiceToolCall(one)).toBe(voiceToolCall(one))
    expect(voiceToolCall({ ...one, status: 'failed' })).not.toBe(voiceToolCall(one))
  })
})

describe('voiceTimeline', () => {
  it('puts every tool call after the line it followed, calls in a row as one band', () => {
    const items = voiceTimeline(
      [line(1, 'user'), line(2, 'assistant'), line(3, 'user')],
      [tool({ id: 'a', after: 1 }), tool({ id: 'b', after: 1 }), tool({ id: 'c', after: 3 })],
    )
    expect(ids(items)).toEqual([1, 'a+b', 2, 3, 'c'])
  })

  it('a call before the first line, or after a line that is gone, comes first', () => {
    const items = voiceTimeline([line(7, 'user')], [tool({ id: 'a', after: 0 }), tool({ id: 'b', after: 2 })])
    expect(ids(items)).toEqual(['a+b', 7])
  })

  it('a call of computer control stands alone, so its pictures never fold into "N steps"', () => {
    const items = voiceTimeline([line(1, 'user')], [
      tool({ id: 'a', after: 1 }),
      tool({ id: 'b', after: 1 }),
      tool({ id: 's', name: 'computer_task', after: 1 }),
      tool({ id: 'u', name: 'computer_use', after: 1 }),
      tool({ id: 'c', after: 1 }),
    ])
    expect(ids(items)).toEqual([1, 'a+b', 's', 'u', 'c'])
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length)
  })
})
