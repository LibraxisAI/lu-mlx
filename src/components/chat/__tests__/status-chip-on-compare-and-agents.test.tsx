// @vitest-environment jsdom
/**
 * Compare showed three dots while a model had not answered yet, and a
 * background agent a spinner with the name of its tool. Both now show the
 * status mark with one word, like the run status line of the chat.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { AgentPanel, taskFace } from '../AgentPanel'
import { ABCompare } from '../ABCompare'
import { useAgentTaskStore } from '../../../stores/agentTaskStore'
import { useChatStore } from '../../../stores/chatStore'
import { useCompareStore } from '../../../stores/compareStore'
import { useUIStore } from '../../../stores/uiStore'

beforeEach(() => {
  cleanup()
  useAgentTaskStore.setState({ byConv: {} })
  useChatStore.setState({ activeConversationId: 'c1' })
  useUIStore.getState().setAgentPanelCollapsed(false)
})

describe('background agents', () => {
  it('reads an activity line as a state of the mark', () => {
    expect(taskFace('thinking')).toEqual({ kind: 'thinking', word: 'Thinking' })
    expect(taskFace('working')).toEqual({ kind: 'working', word: 'Working' })
    expect(taskFace('file_read')).toEqual({ kind: 'reading', word: 'Reading', detail: 'file_read' })
    expect(taskFace('web_search, file_write')).toEqual({ kind: 'searching', word: 'Searching', detail: 'web_search, file_write' })
    expect(taskFace('shell_execute, a, b +2')).toMatchObject({ kind: 'running', word: 'Running' })
    expect(taskFace('mcp__x__y')).toMatchObject({ kind: 'tool', word: 'Using tool' })
  })

  it('a running task shows the mark and the word, with the tool names behind it', () => {
    useAgentTaskStore.getState().start({
      id: 't1', convId: 'c1', goal: 'look it up', context: '', background: true, startedAt: Date.now(), controller: new AbortController(),
    })
    act(() => { useAgentTaskStore.getState().update('t1', { status: 'running', activity: 'web_search' }) })
    render(<AgentPanel />)
    const line = screen.getByTestId('agent-task-activity')
    expect(line.getAttribute('data-status')).toBe('searching')
    expect(line.textContent).toContain('Searching')
    expect(line.textContent).toContain('web_search')
    expect(line.querySelector('[data-testid="status-glyph"]')?.getAttribute('data-kind')).toBe('searching')
  })
})

describe('Compare', () => {
  it('names each side like the model list does, without the provider prefix', () => {
    useCompareStore.setState({ modelA: 'openai::Qwen3.5-9B-Q4_K_M', modelB: 'openai::Holo-3.1-9B.Q4_K_M', isStreamingA: false, isStreamingB: false, messagesA: [], messagesB: [] })
    const view = render(<ABCompare />)
    expect(view.container.textContent).toContain('Qwen3.5-9B-Q4_K_M')
    expect(view.container.textContent).not.toContain('openai::')
  })

  it('a side that has not answered yet shows the status mark, not three dots', () => {
    useCompareStore.setState({
      modelA: 'a', modelB: 'b', isStreamingA: true, isStreamingB: false,
      messagesA: [{ id: 'u', role: 'user', content: 'hi', timestamp: 1 }, { id: 'a1', role: 'assistant', content: '', timestamp: 2 }],
      messagesB: [{ id: 'u', role: 'user', content: 'hi', timestamp: 1 }, { id: 'b1', role: 'assistant', content: 'Hello there', timestamp: 2 }],
    })
    const view = render(<ABCompare />)
    const status = screen.getByTestId('compare-status-a')
    expect(status.textContent).toBe('Starting')
    expect(status.querySelector('[data-testid="status-glyph"]')).not.toBeNull()
    expect(screen.queryByTestId('compare-status-b')).toBeNull()
    expect(view.container.textContent).not.toContain('...')
    expect(view.container.textContent).toContain('Hello there')
  })
})
