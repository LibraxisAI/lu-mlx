/**
 * 3.0.4 box run: "The agent can only open files in this chat's folder..."
 * stayed on top of a NEW chat with Agent off. The two lines about a chat's
 * last message now leave when the conversation changes.
 *
 * Run: npx vitest run src/stores/__tests__/a-chat-notice-stays-with-its-chat.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chatStore'
import { useChatNoticeStore } from '../chatNoticeStore'

const ids = () => useChatNoticeStore.getState().notices.map((n) => n.id)

beforeEach(() => {
  useChatNoticeStore.getState().clear()
  useChatStore.setState({ activeConversationId: null })
})

describe('conversation-bound notices', () => {
  it('leave when the user opens another chat or starts a new one', () => {
    useChatStore.setState({ activeConversationId: 'a' })
    useChatNoticeStore.getState().show('agent-outside-workspace', 'x')
    useChatNoticeStore.getState().show('agent-for-local-files', 'y')
    useChatStore.setState({ activeConversationId: 'b' })
    expect(ids()).toEqual([])

    useChatStore.setState({ activeConversationId: 'a' })
    useChatNoticeStore.getState().show('agent-outside-workspace', 'x')
    useChatStore.setState({ activeConversationId: null })
    expect(ids()).toEqual([])
  })

  it('stay when the first message creates the chat they are about', () => {
    useChatNoticeStore.getState().show('agent-for-local-files', 'y')
    useChatStore.setState({ activeConversationId: 'new' })
    expect(ids()).toEqual(['agent-for-local-files'])
  })

  it('NEGATIVE CONTROL: a line about the model or an attachment is not bound to a chat', () => {
    useChatStore.setState({ activeConversationId: 'a' })
    useChatNoticeStore.getState().show('model-cannot-see-images', 'z')
    useChatStore.setState({ activeConversationId: 'b' })
    expect(ids()).toEqual(['model-cannot-see-images'])
  })
})
