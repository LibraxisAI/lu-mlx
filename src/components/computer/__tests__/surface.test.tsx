// @vitest-environment jsdom
/**
 * What the user sees of LU while it works on the screen: the one panel with
 * what the model does and with Pause and Stop, the question above an input
 * field instead of a dialog at the top, and the paused view with its two
 * answers.
 *
 * Run: npx vitest run src/components/computer/__tests__/surface.test.tsx
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const sent = vi.hoisted(() => ({ answers: [] as boolean[], stops: 0, pauses: 0, autonomy: [] as boolean[], fail: false, corners: [] as (string | null)[] }))
vi.mock('../../../api/computer', () => ({
  COMPUTER_STOPPED_EVENT: 'computer://stopped',
  COMPUTER_PAUSED_EVENT: 'computer://paused',
  getComputerPermissions: async () => ({ ok: true, permissions: { needed: false, accessibility: true, screenRecording: true } }),
  requestComputerAttention: async () => ({ ok: true }),
  setComputerSurface: async () => ({ ok: true, mode: 'window', glow: false, glass: false }),
  moveComputerPanel: async (corner: string | null) => {
    sent.corners.push(corner)
    return { ok: true, mode: 'panel', glow: true, glass: false, corner: corner ?? 'bottom_right' }
  },
  watchComputer: async () => ({ ok: true, paused: false }),
  answerComputerTakeover: async (go: boolean) => {
    sent.answers.push(go)
    if (sent.fail) throw new Error('ipc')
    return { ok: true, paused: false, session: null }
  },
}))
vi.mock('../../../api/computer-use', () => ({
  computerControlBusy: () => true,
  noteComputerStopped: vi.fn(),
  resumeComputerControl: vi.fn(),
  setComputerAutonomy: (next: boolean) => { sent.autonomy.push(next) },
  dismissComputerStop: vi.fn(),
  stopComputerControl: () => { sent.stops += 1 },
  pauseComputerControl: () => { sent.pauses += 1 },
  computerRunOrigin: () => ({ voice: false, conversationId: null }),
}))
vi.mock('../../../api/backend', () => ({ isTauri: () => false }))

import { ComputerControlHost } from '../ComputerControlHost'
import { ComputerQuestionSlot } from '../ComputerQuestion'
import { ComputerSurface } from '../ComputerSurface'
import { chatActivity } from '../ComputerActivity'
import { askActionConfirmation, askAppApproval, refusePendingComputerPrompt } from '../../../lib/computer/prompts'
import { resetComputerPauseForTests, takePauseNote, waitForPauseAnswer } from '../../../lib/computer/pause'
import { useComputerStore } from '../../../stores/computerStore'

const APP = { key: 'notepad.exe', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe', bundleId: null }
const SESSION = { id: 's1', autonomous: false, allowed: [], stopped: null, frameId: null } as never
const TASK = { goal: 'Save the note', maxSteps: 25, steps: [{ n: 1, label: 'Click at 662, 511', ok: null }], phase: 'acting' as const, modelLabel: 'Qwen' }

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  sent.answers = []
  sent.stops = 0
  sent.pauses = 0
  sent.autonomy = []
  sent.fail = false
  sent.corners = []
  refusePendingComputerPrompt()
  resetComputerPauseForTests()
  useComputerStore.setState({
    session: SESSION, stopped: null, prompt: null, notice: null, task: null, working: false, currentApp: null, autonomous: false,
    stopShortcut: 'Ctrl+Alt+Esc', pauseShortcut: 'Ctrl+Alt+Space', surface: 'window', glass: false, corner: 'top_right', paused: false, questionSlots: [],
  })
})

afterEach(() => {
  cleanup()
})

describe('the grip of the panel', () => {
  const drag = (grip: HTMLElement, dx: number, dy: number) => {
    fireEvent.pointerDown(grip, { button: 0, clientX: 190, clientY: 6, pointerId: 1 })
    fireEvent.pointerUp(grip, { button: 0, clientX: 190 + dx, clientY: 6 + dy, pointerId: 1 })
  }

  it('is in the panel while LU works, asks and is paused, and takes none of their room', () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    const { rerender } = render(createElement(ComputerSurface))
    const grip = screen.getByTestId('computer-grip')
    expect(grip.getAttribute('aria-label')).toBe('Move the panel to another corner')
    expect(grip.className).toBe('lu-computer-grip')
    // Pause and Stop stand where they stood.
    expect(screen.getByTestId('computer-pause-button')).toBeTruthy()
    expect(screen.getByTestId('computer-stop')).toBeTruthy()
    act(() => { useComputerStore.setState({ paused: true }) })
    rerender(createElement(ComputerSurface))
    expect(screen.getByRole('alertdialog', { name: 'LU has paused' })).toBeTruthy()
    expect(screen.getByTestId('computer-grip')).toBeTruthy()
  })

  it('a press asks for the next corner, and the panel is drawn where Rust put it', async () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    render(createElement(ComputerSurface))
    fireEvent.click(screen.getByTestId('computer-grip'))
    await flush()
    expect(sent.corners).toEqual([null])
    expect(useComputerStore.getState().corner).toBe('bottom_right')
    expect(screen.getByTestId('computer-surface').getAttribute('data-corner')).toBe('bottom_right')
  })

  it('a drag toward a side asks for the corner there, once, and a drag to where it is asks for nothing', async () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    render(createElement(ComputerSurface))
    const grip = screen.getByTestId('computer-grip')
    drag(grip, -300, 400)
    // The click a browser sends after the button comes up is not a second request.
    fireEvent.click(grip)
    await flush()
    expect(sent.corners).toEqual(['bottom_left'])
    expect(useComputerStore.getState().corner).toBe('bottom_left')
    drag(grip, -200, 0)
    fireEvent.click(grip)
    await flush()
    expect(sent.corners).toEqual(['bottom_left'])
  })

  it('is not there where LU stays a window or covers the display', () => {
    useComputerStore.setState({ surface: 'window', paused: true })
    render(createElement(ComputerSurface))
    expect(screen.getByRole('alertdialog', { name: 'LU has paused' })).toBeTruthy()
    expect(screen.queryByTestId('computer-grip')).toBeNull()
  })
})

describe('the panel', () => {
  it('shows the sign, the step in words, what the task does and the two shortcuts while the agent works', () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    render(createElement(ComputerSurface))
    const panel = screen.getByTestId('computer-panel')
    expect(screen.getByTestId('computer-now').textContent).toBe('Step 1: Click at 662, 511')
    expect(within(panel).getByTestId('computer-task-progress').textContent).toContain('Task: Save the note')
    expect(within(panel).getByTestId('computer-shortcuts').textContent).toContain('Pause Ctrl+Alt+Space')
    expect(within(panel).getByTestId('computer-shortcuts').textContent).toContain('Stop Ctrl+Alt+Esc')
    expect(within(panel).getAllByTestId('status-glyph').length).toBeGreaterThan(0)
    // Nothing waits for the user: the panel does not call for attention.
    expect(screen.getByTestId('computer-surface').hasAttribute('data-waiting')).toBe(false)
  })

  it('Pause and Stop can be pressed at any time, also while the agent has the mouse', () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    render(createElement(ComputerSurface))
    const pause = screen.getByTestId('computer-pause-button')
    const stop = screen.getByTestId('computer-stop')
    expect(pause.getAttribute('aria-keyshortcuts')).toBe('Ctrl+Alt+Space')
    expect(stop.getAttribute('aria-keyshortcuts')).toBe('Ctrl+Alt+Esc')
    fireEvent.click(pause)
    expect(sent.pauses).toBe(1)
    fireEvent.click(stop)
    expect(sent.stops).toBe(1)
  })

  it('says "Working on the screen" before a task has a step', () => {
    useComputerStore.setState({ surface: 'panel' })
    render(createElement(ComputerSurface))
    expect(screen.getByTestId('computer-now').textContent).toBe('Working on the screen')
  })

  it('is one and the same element at work, with a question and paused: nothing is swapped for another shape', async () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    render(createElement(ComputerSurface))
    const surface = screen.getByTestId('computer-surface')
    const panel = screen.getByTestId('computer-panel')
    const style = surface.getAttribute('style')
    expect(style).toContain('380px')
    expect(style).toContain('480px')

    act(() => { void askActionConfirmation({ app: APP, description: 'Click at 662, 511 in Notepad', reason: null, sensitive: false }) })
    await flush()
    expect(within(panel).getByRole('group', { name: 'Confirm this action' })).toBeTruthy()
    expect(screen.getByTestId('computer-now').textContent).toBe('Waiting for your answer')
    expect(surface.hasAttribute('data-waiting')).toBe(true)
    // The shortcuts make room for the question; Pause and Stop stay.
    expect(within(panel).queryByTestId('computer-shortcuts')).toBeNull()
    expect(within(panel).getByTestId('computer-stop')).toBeTruthy()

    act(() => { void waitForPauseAnswer() })
    act(() => { useComputerStore.getState().setPaused(true) })
    expect(within(panel).getByRole('alertdialog', { name: 'LU has paused' })).toBeTruthy()
    expect(surface.hasAttribute('data-waiting')).toBe(true)

    expect(screen.getByTestId('computer-surface')).toBe(surface)
    expect(screen.getByTestId('computer-panel')).toBe(panel)
    expect(surface.getAttribute('style')).toBe(style)
    expect(surface.getAttribute('data-surface')).toBe('panel')
  })

  it('the Autonomous switch in a question says what it is set to and asks for the session to be switched', async () => {
    useComputerStore.setState({ surface: 'panel', task: TASK })
    render(createElement(ComputerSurface))
    act(() => { void askActionConfirmation({ app: APP, description: 'Click at 662, 511 in Notepad', reason: null, sensitive: false }) })
    await flush()
    const toggle = screen.getByRole('button', { name: 'Autonomous' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('computer-autonomy-state').textContent).toContain('Supervised: you confirm every action.')
    fireEvent.click(toggle)
    expect(sent.autonomy).toEqual([true])
    act(() => { useComputerStore.getState().setAutonomous(true) })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('computer-autonomy-state').textContent).toContain('On for this session:')
    // The question is still the question, in the same panel.
    expect(within(screen.getByTestId('computer-panel')).getByRole('button', { name: 'Confirm' })).toBeTruthy()
  })

  it('the page under it is taken out of view and comes back with the window', () => {
    useComputerStore.setState({ surface: 'panel' })
    render(createElement(ComputerSurface))
    expect(document.documentElement.dataset.computerSurface).toBe('panel')
    act(() => { useComputerStore.getState().setSurface('window') })
    expect(document.documentElement.dataset.computerSurface).toBe('window')
    expect(screen.queryByTestId('computer-surface')).toBeNull()
  })
})

describe('a question', () => {
  it('stands in the place above the input field, with the old words, buttons and first focus, and is no dialog', async () => {
    render(createElement('div', null, createElement(ComputerQuestionSlot), createElement('textarea', { 'aria-label': 'Message' }), createElement(ComputerControlHost)))
    let answer: string | null = null
    act(() => { void askAppApproval(APP, null).then((value) => { answer = value }) })
    await flush()
    const question = screen.getByRole('group', { name: 'Allow LU to control Notepad?' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('computer-question-fallback')).toBeNull()
    // Above the input field in the document.
    expect(question.compareDocumentPosition(screen.getByLabelText('Message')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(question.textContent).toContain('Terminals, password managers, system dialogs and LU itself stay off limits')
    for (const name of ['Deny', 'Always allow', 'Allow once', 'Allow for this session']) expect(within(question).getByRole('button', { name })).toBeTruthy()
    // The way out has the focus, as in the confirmation: the question takes the
    // focus from wherever the user was typing, and the Enter that was meant for
    // a message must not allow an app.
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Deny' }))
    fireEvent.click(within(question).getByRole('button', { name: 'Allow for this session' }))
    await flush()
    expect(answer).toBe('session')
    expect(screen.queryByTestId('computer-question')).toBeNull()
  })

  it('Escape means no, and a sensitive action offers no way around the click', async () => {
    render(createElement('div', null, createElement(ComputerQuestionSlot), createElement(ComputerControlHost)))
    let answer: boolean | null = null
    act(() => {
      void askActionConfirmation({ app: APP, description: 'Click at 500, 300 in Notepad', reason: 'The click target "Send" usually sends something. It needs your confirmation.', sensitive: true })
        .then((value) => { answer = value })
    })
    await flush()
    const question = screen.getByRole('group', { name: 'Confirm this action' })
    expect(question.textContent).toContain('also in an autonomous session')
    expect(within(question).queryByRole('button', { name: 'Autonomous' })).toBeNull()
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Decline' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await flush()
    expect(answer).toBe(false)
  })

  it('shows once when two views offer a place, and at the bottom edge when none does', async () => {
    const view = render(createElement('div', null, createElement(ComputerQuestionSlot), createElement(ComputerQuestionSlot), createElement(ComputerControlHost)))
    act(() => { void askActionConfirmation({ app: APP, description: 'Type in Notepad: hi', reason: null, sensitive: false }) })
    await flush()
    expect(screen.getAllByTestId('computer-question')).toHaveLength(1)
    // An ordinary action offers the switch right where the user is asked.
    expect(within(screen.getByTestId('computer-question')).getByRole('button', { name: 'Autonomous' })).toBeTruthy()
    view.unmount()
    refusePendingComputerPrompt()

    render(createElement(ComputerControlHost))
    act(() => { void askActionConfirmation({ app: APP, description: 'Type in Notepad: hi', reason: null, sensitive: false }) })
    await flush()
    expect(within(screen.getByTestId('computer-question-fallback')).getByRole('group', { name: 'Confirm this action' })).toBeTruthy()
  })

  it('stands in the panel instead while LU is shrunk: the places in the window stay empty', async () => {
    useComputerStore.setState({ surface: 'panel' })
    render(createElement('div', { 'data-testid': 'window' }, createElement(ComputerQuestionSlot), createElement(ComputerControlHost)))
    act(() => { void askAppApproval(APP, null) })
    await flush()
    expect(within(screen.getByTestId('window')).queryByTestId('computer-question')).toBeNull()
    const panel = screen.getByTestId('computer-panel')
    expect(within(panel).getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeTruthy()
    // The agent waits, so Stop can be pressed here.
    fireEvent.click(within(panel).getByTestId('computer-stop'))
    expect(sent.stops).toBe(1)
    // No bar in a window that is the panel.
    expect(screen.queryByTestId('computer-control-bar')).toBeNull()
  })
})

describe('the paused view', () => {
  function pause() {
    const state = { answer: null as boolean | null }
    act(() => { void waitForPauseAnswer().then((go) => { state.answer = go }) })
    act(() => { useComputerStore.getState().setSurface('pause') })
    return state
  }

  it('asks with two buttons, starts on the safe one and has no timer', async () => {
    vi.useFakeTimers()
    try {
      render(createElement(ComputerSurface))
      const state = pause()
      const view = screen.getByRole('alertdialog', { name: 'LU has paused' })
      expect(view.textContent).toContain('LU does nothing until you choose.')
      expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Take over' }))
      expect(within(view).getByRole('button', { name: 'Let it continue' })).toBeTruthy()
      expect(document.activeElement).not.toBe(within(view).getByLabelText('Instruction for LU'))
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000) })
      expect(state.answer).toBeNull()
      expect(sent.answers).toEqual([])
      expect(screen.getByRole('alertdialog')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('covers the window where the window does not shrink, and the page under it stays', async () => {
    useComputerStore.setState({ surface: 'window', paused: true })
    render(createElement(ComputerSurface))
    const view = screen.getByRole('alertdialog', { name: 'LU has paused' })
    expect(within(view).getByRole('button', { name: 'Take over' })).toBeTruthy()
    expect(screen.getByTestId('computer-surface').getAttribute('data-surface')).toBe('pause')
    expect(document.documentElement.dataset.computerSurface).toBe('window')
    fireEvent.click(within(view).getByRole('button', { name: 'Let it continue' }))
    await flush()
    expect(sent.answers).toEqual([true])
  })

  it('"Let it continue" sends the answer and the instruction that was typed', async () => {
    render(createElement(ComputerSurface))
    const state = pause()
    fireEvent.change(screen.getByLabelText('Instruction for LU'), { target: { value: 'use the second tab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Let it continue' }))
    await flush()
    expect(sent.answers).toEqual([true])
    expect(state.answer).toBe(true)
    expect(takePauseNote()).toBe('use the second tab')
    expect(useComputerStore.getState().paused).toBe(false)
  })

  it('Enter in the instruction field continues, Escape anywhere takes over', async () => {
    render(createElement(ComputerSurface))
    let state = pause()
    fireEvent.submit(screen.getByLabelText('Instruction for LU').closest('form')!)
    await flush()
    expect(state.answer).toBe(true)

    state = pause()
    fireEvent.keyDown(screen.getByLabelText('Instruction for LU'), { key: 'Escape' })
    await flush()
    expect(sent.answers).toEqual([true, false])
    expect(state.answer).toBe(false)
  })

  it('"Take over" ends it and drops what was typed', async () => {
    render(createElement(ComputerSurface))
    const state = pause()
    fireEvent.change(screen.getByLabelText('Instruction for LU'), { target: { value: 'never mind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
    await flush()
    expect(sent.answers).toEqual([false])
    expect(state.answer).toBe(false)
    expect(takePauseNote()).toBeNull()
  })

  it('stays up when the answer did not reach Rust: nothing is continued on a guess', async () => {
    sent.fail = true
    render(createElement(ComputerSurface))
    const state = pause()
    fireEvent.click(screen.getByRole('button', { name: 'Let it continue' }))
    await flush()
    expect(state.answer).toBeNull()
    expect(useComputerStore.getState().paused).toBe(true)
  })
})

describe('what a chat run did, for the panel', () => {
  const call = (id: string, toolName: string) => ({ id, toolName, args: {}, status: 'completed' as const, timestamp: 1 })
  const block = (id: string, phase: 'thinking' | 'reflection' | 'tool_call', content: string, toolCalls?: ReturnType<typeof call>[]) => ({ id, phase, content, timestamp: 1, toolCalls })

  it('keeps the order of thoughts, calls and written text, and gives a call of computer control a band of its own', () => {
    const items = chatActivity([
      block('b1', 'thinking', 'The note has to be saved.'),
      block('b2', 'tool_call', 'Running: file_read', [call('c1', 'file_read')]),
      block('b3', 'tool_call', 'Running: file_read', [call('c2', 'file_read')]),
      block('b4', 'tool_call', 'Running: computer_task', [call('c3', 'computer_task')]),
      block('b5', 'reflection', 'The note is saved.'),
      block('b6', 'reflection', '   '),
    ] as never)
    expect(items.map((item) => item.kind)).toEqual(['thinking', 'tools', 'tools', 'text'])
    expect(items[1]).toMatchObject({ calls: [{ id: 'c1' }, { id: 'c2' }] })
    expect(items[2]).toMatchObject({ calls: [{ id: 'c3' }] })
    expect(items[3]).toMatchObject({ text: 'The note is saved.' })
  })
})
