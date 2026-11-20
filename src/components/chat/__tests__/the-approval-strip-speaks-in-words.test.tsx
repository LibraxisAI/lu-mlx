/**
 * @vitest-environment jsdom
 *
 * The approval strip above the composer read "APPROVE file_write": the tool's
 * internal name where a person decides something (Windows run of 07.10.2026).
 * It says what is about to happen in the words of the run status. The name is
 * the tooltip and the first line behind the arrow.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-approval-strip-speaks-in-words.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ApprovalDialog } from '../ApprovalDialog'
import type { AgentToolCall } from '../../../types/agent-mode'

const call = (toolName: string): AgentToolCall => ({ id: 'c1', toolName, args: { path: 'note.txt' }, status: 'pending_approval', timestamp: 0 })

afterEach(() => cleanup())

describe('the approval strip', () => {
  it.each([
    ['file_write', 'change a file'],
    ['shell_execute', 'run a command'],
    ['web_fetch', 'use the web'],
    ['computer_task', 'work on the screen'],
    ['some_mcp_tool', 'use a tool'],
  ])('%s reads "Approve %s", the name is the tooltip', (name, words) => {
    const view = render(createElement(ApprovalDialog, { toolCall: call(name), onApprove: vi.fn(), onReject: vi.fn() }))
    const what = view.getByTestId('approval-what')
    expect(what.textContent).toBe(words)
    expect(what.getAttribute('title')).toBe(name)
    expect(view.container.textContent).toContain('Approve')
    expect(view.container.textContent).not.toContain(name)
    expect(view.container.textContent).not.toMatch(/[–—]/)
  })

  it('the arrow shows the name and the arguments', () => {
    const view = render(createElement(ApprovalDialog, { toolCall: call('file_write'), onApprove: vi.fn(), onReject: vi.fn() }))
    fireEvent.click(view.getByTitle('Show arguments'))
    expect(view.container.querySelector('pre')?.textContent).toBe('file_write\n{\n  "path": "note.txt"\n}')
  })

  it('another surface asks in a whole sentence of its own', () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const view = render(createElement(ApprovalDialog, { toolCall: call('file_write'), onApprove, onReject, question: 'Voice wants to change a file.' }))
    expect(view.getByTestId('approval-what').textContent).toBe('Voice wants to change a file.')
    expect(view.getByTestId('approval-what').getAttribute('title')).toBe('file_write')
    fireEvent.click(view.getByRole('button', { name: 'Approve' }))
    fireEvent.click(view.getByRole('button', { name: 'Reject' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
  })
})
