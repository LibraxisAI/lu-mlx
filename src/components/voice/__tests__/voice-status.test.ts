import { describe, expect, it } from 'vitest'
import { voiceStatus, voiceStatusText } from '../voice-status'
import { MOTIFS } from '../../status/glyph-motifs'
import type { VoiceSessionState } from '../../../lib/voice/session-state'

type Input = Pick<VoiceSessionState, 'activity' | 'muted' | 'approval' | 'runningTool'>
const base: Input = { activity: 'listening', muted: false, approval: null, runningTool: null }
const text = (state: Partial<Input>, screen?: { step: string | null; asking: boolean; paused?: boolean } | null) =>
  voiceStatusText(voiceStatus({ ...base, ...state }, screen))

describe('voice status line', () => {
  it('keeps the words the session always had', () => {
    expect(text({})).toBe('Listening')
    expect(text({ muted: true })).toBe('Microphone muted')
    expect(text({ activity: 'hearing' })).toBe('Listening')
    expect(text({ activity: 'thinking' })).toBe('Thinking')
    expect(text({ activity: 'speaking' })).toBe('Speaking')
    expect(text({ activity: 'tool', approval: { id: 'c1', name: 'file_write', args: {} } })).toBe('Waiting for your approval')
  })

  it('names a running tool in plain words, never by its technical name', () => {
    expect(text({ activity: 'tool', runningTool: 'file_write' })).toBe('Writing')
    expect(text({ activity: 'tool', runningTool: 'shell_execute' })).toBe('Running')
    expect(text({ activity: 'tool', runningTool: 'web_search' })).toBe('Searching')
    expect(text({ activity: 'tool', runningTool: 'file_read' })).toBe('Reading')
    expect(text({ activity: 'tool', runningTool: 'mcp__notes__add' })).toBe('Using tool')
    expect(text({ activity: 'tool', runningTool: null })).toBe('Using tool')
    for (const name of ['file_write', 'shell_execute', 'web_search', 'computer_task', 'mcp__notes__add']) {
      expect(text({ activity: 'tool', runningTool: name })).not.toContain(name)
    }
  })

  it('shows the step of a running screen task while nobody talks', () => {
    const task: Partial<Input> = { activity: 'tool', runningTool: 'computer_task' }
    expect(text(task, { step: 'Click at 500, 500', asking: false })).toBe('Working on the screen: Click at 500, 500')
    expect(text(task, { step: null, asking: false })).toBe('Working on the screen')
    expect(text(task, null)).toBe('Working on the screen')
  })

  it('says "Paused" while the screen task is paused, before a question that is open under the paused view', () => {
    const task: Partial<Input> = { activity: 'tool', runningTool: 'computer_task' }
    expect(text(task, { step: 'Click at 500, 500', asking: false, paused: true })).toBe('Paused')
    expect(text(task, { step: null, asking: true, paused: true })).toBe('Paused')
    expect(text({ activity: 'speaking' }, { step: null, asking: false, paused: true })).toBe('Paused')
    // A tool of the voice session itself that waits for approval still comes first.
    expect(text({ ...task, approval: { id: 'a', name: 'shell_execute', args: {} } }, { step: null, asking: false, paused: true })).toBe('Waiting for your approval')
  })

  it('puts an open question before everything, and speech before the step', () => {
    const task: Partial<Input> = { activity: 'tool', runningTool: 'computer_task' }
    expect(text(task, { step: 'Type text', asking: true })).toBe('Waiting for your answer')
    expect(text({ ...task, activity: 'speaking' }, { step: 'Type text', asking: false })).toBe('Speaking')
    expect(text({ ...task, activity: 'hearing' }, { step: 'Type text', asking: false })).toBe('Listening')
  })

  it('counts listening and speaking as no work, and names every other state as the chat does', () => {
    expect(voiceStatus(base).kind).toBeNull()
    expect(voiceStatus({ ...base, activity: 'speaking' }).kind).toBeNull()
    const marked = [
      voiceStatus({ ...base, activity: 'thinking' }),
      voiceStatus({ ...base, activity: 'tool', runningTool: 'file_write' }),
      voiceStatus({ ...base, activity: 'tool', runningTool: 'computer_task' }, { step: null, asking: false }),
      voiceStatus({ ...base, approval: { id: 'c1', name: 'file_write', args: {} } }),
    ]
    for (const status of marked) expect(MOTIFS[status.kind!]).toBeDefined()
  })
})
