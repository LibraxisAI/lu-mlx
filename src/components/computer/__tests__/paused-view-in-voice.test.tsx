// @vitest-environment jsdom
/**
 * The paused view of computer control during a voice session.
 *
 * The view shows what the model did so far. In a voice session that is the
 * session's tool calls and, between them, the thoughts of its model: each one
 * as the chat's folded thinking block ("Thought for 4 s"), never as running
 * text. What was said aloud belongs to the transcript and is not repeated.
 *
 * Run: npx vitest run src/components/computer/__tests__/paused-view-in-voice.test.tsx
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../../../api/computer', () => ({
  answerComputerTakeover: async () => ({ ok: true, paused: false, session: null }),
}))
vi.mock('../../../api/computer-use', () => ({
  stopComputerControl: vi.fn(),
  pauseComputerControl: vi.fn(),
  computerRunOrigin: () => ({ voice: true, conversationId: null }),
}))

import { ComputerSurface } from '../ComputerSurface'
import { voiceActivity } from '../ComputerActivity'
import { resetComputerPauseForTests } from '../../../lib/computer/pause'
import { useComputerStore } from '../../../stores/computerStore'
import { useVoiceSessionStore } from '../../../stores/voiceSessionStore'
import type { VoiceLine, VoiceToolLine } from '../../../lib/voice/session-state'

const THOUGHT = 'The user wants the note saved. The Save button is in the toolbar, so one click should do.'
const LINES: VoiceLine[] = [
  { id: 1, role: 'user', text: 'Click the Save button in the editor on my screen.', final: true },
  { id: 2, role: 'thought', text: THOUGHT, final: true, secs: 3.6 },
  { id: 3, role: 'assistant', text: 'I will save the note.', final: true },
]
const TOOLS: VoiceToolLine[] = [
  { id: 'call-1', name: 'computer_task', status: 'running', args: { goal: 'Click the Save button' }, after: 3 },
]

beforeEach(() => {
  resetComputerPauseForTests()
  useComputerStore.setState({
    session: null, stopped: null, prompt: null, notice: null, working: true, currentApp: null, autonomous: true,
    task: { goal: 'Click the Save button', maxSteps: 25, steps: [{ n: 1, label: 'Click at 662, 511', ok: true }], phase: 'looking', modelLabel: 'Qwen' },
    stopShortcut: 'Ctrl+Alt+Esc', pauseShortcut: 'Ctrl+Alt+Space', surface: 'pause', glass: false, paused: true, pauseAsked: false, questionSlots: [],
  })
  useVoiceSessionStore.setState({ lines: LINES, tools: TOOLS })
})

afterEach(() => {
  cleanup()
  useVoiceSessionStore.setState({ lines: [], tools: [] })
})

describe('the paused view during a voice session', () => {
  it('shows a thought of the model as the folded thinking block, not as text', () => {
    render(createElement(ComputerSurface))
    const view = screen.getByRole('alertdialog', { name: 'LU has paused' })
    const activity = within(view).getByTestId('computer-activity')
    const thoughts = activity.querySelectorAll('[data-role="thought"]')
    expect(thoughts).toHaveLength(1)
    const toggle = within(thoughts[0] as HTMLElement).getByRole('button', { name: 'Toggle thinking details' })
    expect(toggle.textContent).toBe('Thought for 4 s')
    // Folded: the words of the thought are not on the page.
    expect(view.textContent).not.toContain('The Save button is in the toolbar')
    expect(view.textContent).not.toMatch(/<\/?think>/)
    // Opened by the user, they are.
    fireEvent.click(toggle)
    expect(thoughts[0].textContent).toContain('The Save button is in the toolbar')
  })

  it('a thought that is still coming in shows as "Thinking", in the block, as in the transcript', () => {
    useVoiceSessionStore.setState({ lines: [{ id: 2, role: 'thought', text: 'Looking for the button', final: false }], tools: [] })
    render(createElement(ComputerSurface))
    const thought = screen.getByTestId('computer-activity').querySelector('[data-role="thought"]') as HTMLElement
    expect(within(thought).getByRole('button', { name: 'Toggle thinking details' }).textContent).toBe('Thinking')
  })

  it('keeps the order of the session, shows its tool call, and leaves what was said to the transcript', () => {
    expect(voiceActivity(LINES, TOOLS).map((item) => item.kind)).toEqual(['thought', 'tools'])
    render(createElement(ComputerSurface))
    const activity = screen.getByTestId('computer-activity')
    expect(activity.querySelector('[data-tool="computer_task"]')).not.toBeNull()
    expect(activity.textContent).not.toContain('I will save the note.')
    expect(activity.textContent).not.toContain('Click the Save button in the editor on my screen.')
    // The thought stands before the call it led to.
    const thought = activity.querySelector('[data-role="thought"]')!
    const tools = activity.querySelector('[role="group"][aria-label="Tools"]')!
    expect(thought.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says how the pause came about: by the hand, or because the user asked by voice', () => {
    render(createElement(ComputerSurface))
    expect(screen.getByRole('alertdialog').textContent).toContain('You moved the mouse or pressed a key. LU does nothing until you choose.')
    act(() => { useComputerStore.setState({ pauseAsked: true }) })
    expect(screen.getByRole('alertdialog').textContent).toContain('You asked LU to wait. LU does nothing until you choose.')
    expect(screen.getByRole('alertdialog').textContent).not.toContain('You moved the mouse')
    // The next pause is not marked as asked for.
    act(() => { useComputerStore.getState().setPaused(false) })
    expect(useComputerStore.getState().pauseAsked).toBe(false)
  })
})
