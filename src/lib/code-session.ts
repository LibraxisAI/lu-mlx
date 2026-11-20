// One way to start a Code session, for the New button in the Code area and
// for New Chat in the sidebar. The sidebar used to create the conversation
// itself: every click added an empty "Coding Agent" row and reset Bypass to
// Ask, which the Code button had stopped doing (3.0.4 Gegenprobe 8).
import { useChatStore } from '../stores/chatStore'
import { useCodexStore } from '../stores/codexStore'

/** Opens a fresh Code session, or keeps the open one when it is untouched. */
export function openNewCodeSession(model: string): void {
  const { conversations, activeConversationId, createConversation } = useChatStore.getState()
  const open = conversations.find((c) => c.id === activeConversationId)
  // An untouched session IS a new session.
  if (open?.mode === 'codex' && open.messages.length === 0
    && !(useCodexStore.getState().threads[open.id]?.events.length)) return
  const convId = createConversation(model, '', 'codex')
  // "New" keeps the Ask/Bypass the user last picked (Gegenprobe 01.10.2026).
  useCodexStore.getState().startConversationMode(convId)
}
