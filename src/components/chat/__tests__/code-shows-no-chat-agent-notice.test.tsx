/**
 * @vitest-environment jsdom
 *
 * Gegenprobe 01.10.2026: the Chat Agent's line "click the Sandbox or folder
 * button next to Agent" also showed in the Code area, which has no such
 * button (its folder is picked in the file tree). The Code area leaves the
 * Chat Agent's lines out; every other line still shows there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { ChatNotices } from '../ChatNotices'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'
import { OUTSIDE_WORKSPACE_NOTICE } from '../../../lib/workspace-refusal'

beforeEach(() => {
  useChatNoticeStore.setState({ notices: [] })
  useChatNoticeStore.getState().show('agent-outside-workspace', OUTSIDE_WORKSPACE_NOTICE)
  useChatNoticeStore.getState().show('model-cannot-see-images', 'This model cannot see images.')
})
afterEach(() => cleanup())

describe('the Chat Agent line stays in Chat', () => {
  it('Chat shows it', () => {
    render(createElement(ChatNotices))
    expect(screen.getByTestId('chat-notices').textContent).toContain('next to Agent')
  })

  it('Code leaves it out and keeps the rest', () => {
    render(createElement(ChatNotices, { surface: 'code' }))
    const text = screen.getByTestId('chat-notices').textContent ?? ''
    expect(text).not.toContain('next to Agent')
    expect(text).toContain('cannot see images')
  })
})
