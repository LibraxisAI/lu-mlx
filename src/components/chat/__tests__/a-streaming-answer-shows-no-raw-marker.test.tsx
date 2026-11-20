/**
 * @vitest-environment jsdom
 *
 * Gegenprobe 01.10.2026: "I created a file named `" stood with a raw backtick
 * while the answer streamed. While it streams, an open marker is closed for
 * the frame; a finished answer shows exactly what the model wrote.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '../../../types/chat'

afterEach(() => cleanup())

const msg = (content: string): Message =>
  ({ id: 'm1', role: 'assistant', content, timestamp: 1 }) as Message

const bubble = (content: string, isStreaming: boolean) =>
  render(createElement(MessageBubble, { message: msg(content), isStreaming, isLast: true }))

describe('a streaming answer', () => {
  it('does not show the lone backtick at its end', () => {
    const { container } = bubble('I created a file named `', true)
    expect(container.querySelector('.markdown-content')?.textContent).not.toContain('`')
  })

  it('renders an open code span as code already', () => {
    const { container } = bubble('I created a file named `notes', true)
    expect(container.querySelector('.markdown-content code')?.textContent).toBe('notes')
  })

  it('a finished answer is left exactly as written', () => {
    const { container } = bubble('A lone ` stays', false)
    expect(container.querySelector('.markdown-content')?.textContent).toContain('`')
  })
})
