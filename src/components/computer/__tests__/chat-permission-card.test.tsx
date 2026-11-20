// @vitest-environment jsdom
/**
 * "Allow computer control in this chat?" is the card of the tool call in the
 * conversation, with Allow and Deny. It is not in or over the chat input, it
 * shows in the chat that asked and nowhere else, and only a click answers.
 *
 * Run: npx vitest run src/components/computer/__tests__/chat-permission-card.test.tsx
 */
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

const answered = vi.hoisted(() => [] as { id: string; allow: boolean }[])
vi.mock('../../../api/computer-chat', () => ({
  answerComputerChatAsk: (id: string, allow: boolean) => { answered.push({ id, allow }) },
}))
vi.mock('../../../api/backend', async (original) => ({
  ...(await original<typeof import('../../../api/backend')>()),
  isMacOS: () => false,
}))

import { ToolCallBlock } from '../../chat/ToolCallBlock'
import { ComputerChatPermission } from '../ComputerChatPermission'
import { useComputerStore, type ComputerChatAsk } from '../../../stores/computerStore'
import { useChatStore } from '../../../stores/chatStore'
import type { AgentToolCall } from '../../../types/agent-mode'

const ask = (over: Partial<ComputerChatAsk> = {}): ComputerChatAsk => ({ id: 'computer-chat-ask-1', chatKey: 'chat-a', conversationId: 'chat-a', voice: false, ...over })
const call = (over: Partial<AgentToolCall> = {}): AgentToolCall => ({ id: 'call-1', toolName: 'computer_task', args: { goal: 'Type hello into Notepad.' }, status: 'running', timestamp: 1, ...over })
const card = () => document.querySelector('[data-testid="computer-chat-permission"]')
const show = (toolCall: AgentToolCall) => render(createElement(ToolCallBlock, { toolCall }))

beforeEach(() => {
  answered.length = 0
  useChatStore.setState({ activeConversationId: 'chat-a' })
  useComputerStore.setState({ chatAsk: null })
})
afterEach(cleanup)

describe('the card of the first use in a chat', () => {
  it('stands in the tool call of the chat that asked, and says what is allowed, that it is Beta and how to stop', () => {
    useComputerStore.setState({ chatAsk: ask() })
    show(call())
    const text = card()!.textContent!
    expect(text).toContain('Allow computer control in this chat?')
    expect(text).toContain('in this chat only')
    expect(text).toContain('Ctrl+Alt+Esc')
    expect(card()!.querySelector('[data-beta="computer-control"]')).not.toBeNull()
    expect([...card()!.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual(['Allow', 'Deny'])
    expect(text).not.toMatch(/[–—]/)
  })

  it('Allow and Deny answer the question that is open', () => {
    useComputerStore.setState({ chatAsk: ask() })
    show(call())
    fireEvent.click(card()!.querySelector('[data-testid="computer-chat-deny"]')!)
    fireEvent.click(card()!.querySelector('[data-testid="computer-chat-allow"]')!)
    expect(answered).toEqual([{ id: 'computer-chat-ask-1', allow: false }, { id: 'computer-chat-ask-1', allow: true }])
  })

  it('no key answers it: Enter and Escape on the card do nothing', () => {
    useComputerStore.setState({ chatAsk: ask() })
    show(call())
    fireEvent.keyDown(card()!, { key: 'Enter' })
    fireEvent.keyDown(card()!, { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(answered).toEqual([])
  })

  it('is gone without a question, in a call that is over, in another tool and in another chat', () => {
    show(call())
    expect(card()).toBeNull()
    cleanup()
    useComputerStore.setState({ chatAsk: ask() })
    show(call({ status: 'completed', result: 'done' }))
    expect(card()).toBeNull()
    cleanup()
    show(call({ toolName: 'web_search', args: { query: 'x' } }))
    expect(card()).toBeNull()
    cleanup()
    // The user looks at another conversation while chat-a waits.
    useChatStore.setState({ activeConversationId: 'chat-b' })
    show(call())
    expect(card()).toBeNull()
  })

  it('computer_use gets the same card', () => {
    useComputerStore.setState({ chatAsk: ask() })
    show(call({ toolName: 'computer_use', args: { action: 'screenshot' } }))
    expect(card()).not.toBeNull()
  })

  it('a question of a voice session is not a card of the chat: the voice surface shows it', () => {
    useComputerStore.setState({ chatAsk: ask({ voice: true, conversationId: 'chat-a' }) })
    show(call())
    expect(card()).toBeNull()
    cleanup()
    render(createElement(ComputerChatPermission, { ask: ask({ voice: true }) }))
    expect(card()).not.toBeNull()
    const panel = readFileSync(resolve(__dirname, '../../voice/VoiceSessionPanel.tsx'), 'utf8')
    expect(panel).toContain('<ComputerChatPermission ask={chatAsk} />')
  })

  it('while the card waits, the status of the run says that it waits for the user, not that it works', () => {
    const list = readFileSync(resolve(__dirname, '../../chat/MessageList.tsx'), 'utf8')
    expect(list).toContain('awaitingApproval={!!pendingApprovalId || chatAsked}')
    const code = readFileSync(resolve(__dirname, '../../chat/CodexView.tsx'), 'utf8')
    expect(code).toContain('awaitingApproval={!!pendingConfirm || chatAsked}')
  })

  it('nothing of it stands in or over the chat input', () => {
    const input = readFileSync(resolve(__dirname, '../../chat/ChatInput.tsx'), 'utf8')
    expect(input).not.toContain('ComputerChatPermission')
    expect(input).not.toContain('chatAsk')
    const slot = readFileSync(resolve(__dirname, '../ComputerQuestion.tsx'), 'utf8')
    expect(slot).not.toContain('chatAsk')
  })
})
