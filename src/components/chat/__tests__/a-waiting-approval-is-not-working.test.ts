/**
 * @vitest-environment jsdom
 *
 * Gegenprobe on the real Windows build, 01.10.2026: an Agent run in the chat
 * waiting on an approval read "Working 49s" and kept counting, while the Code
 * tab in the same spot says "Waiting for your approval" (G15b). A run that
 * waits on the user now says so in the chat too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { MessageList } from '../MessageList'
import { useChatStore } from '../../../stores/chatStore'
import type { Conversation } from '../../../types/chat'

vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

beforeEach(() => {
  Element.prototype.scrollTo = () => {}
  const conv: Conversation = {
    id: 'c1', title: 'Poem', model: 'test-model', systemPrompt: '', mode: 'lu', createdAt: 1, updatedAt: 1,
    messages: [
      { id: 'u1', role: 'user', content: 'write a poem to poem.txt', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2 },
    ],
  }
  useChatStore.setState({ conversations: [conv], activeConversationId: 'c1' })
})
afterEach(() => cleanup())

const anchor = () => screen.getByTestId('working-anchor').textContent ?? ''

describe('the chat anchor while an approval waits', () => {
  it('says the run waits for the user, not that it works', () => {
    render(createElement(MessageList, { isGenerating: true, isThisChatGenerating: true, pendingApprovalId: 'tool-1', onApprove: () => {}, onReject: () => {} }))
    expect(anchor()).toContain('Waiting for your approval')
    expect(anchor()).not.toContain('Working')
  })

  it('without a pending approval it names what the run is doing instead', () => {
    // The answer is still empty, so the run is at its start.
    render(createElement(MessageList, { isGenerating: true, isThisChatGenerating: true, pendingApprovalId: null }))
    expect(anchor()).toContain('Starting')
    expect(anchor()).not.toContain('Waiting for your approval')
  })
})
