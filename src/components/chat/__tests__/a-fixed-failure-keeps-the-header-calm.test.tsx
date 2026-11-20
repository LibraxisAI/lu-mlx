/**
 * @vitest-environment jsdom
 *
 * Gegenprobe 01.10.2026: "3 steps" carried a red mark although the run fixed
 * its one failed step itself and ended well. The header now marks only a
 * failure the run did not fix (lib/recovered-failure.ts).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { ToolCallBand } from '../ToolCallBand'
import type { AgentToolCall } from '../../../types/agent-mode'

afterEach(() => cleanup())

let n = 0
const call = (toolName: string, status: AgentToolCall['status'], path: string): AgentToolCall =>
  ({ id: `t${++n}`, toolName, args: { path }, status, timestamp: n, duration: 12 }) as AgentToolCall

const redMark = (el: HTMLElement) => el.querySelector('.text-red-400\\/60')

describe('the steps header after a run', () => {
  it('fixed by the run itself: no red mark', () => {
    const { container } = render(createElement(ToolCallBand, { calls: [
      call('file_write', 'failed', 'C:\\Users\\x\\Desktop\\poem.txt'),
      call('file_write', 'completed', 'poem.txt'),
      call('file_read', 'completed', 'poem.txt'),
    ] }))
    expect(container.textContent).toContain('3 steps')
    expect(redMark(container)).toBeNull()
  })

  it('not fixed: the red mark stays', () => {
    const { container } = render(createElement(ToolCallBand, { calls: [
      call('file_read', 'failed', 'C:\\data\\sales.csv'),
      call('file_list', 'completed', '.'),
    ] }))
    expect(redMark(container)).not.toBeNull()
  })
})
