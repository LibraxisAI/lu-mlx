import { useChatStore } from '../stores/chatStore'

/**
 * What a stopped run's answer says when nothing else would. Gegenprobe on the
 * real Windows build, 01.10.2026: Stop on a Code run before the model's first
 * token left an empty bubble with only the logo, which read as a crash. The
 * run state is kept for the next message ("continue" picks up, same probe).
 */
export const STOPPED_NOTE = 'Stopped. Send "continue" to pick up from here.'

/** Write the note into the run's answer, only if the answer shows nothing yet. */
export function noteStoppedIfEmpty(conversationId: string | null | undefined, messageId: string): void {
  if (!conversationId) return
  const msg = useChatStore.getState().conversations
    .find((c) => c.id === conversationId)?.messages.find((m) => m.id === messageId)
  if (!msg || msg.content.trim()) return
  const shows = (msg.agentBlocks ?? []).some((b) => b.phase === 'tool_call' || (b.phase === 'answer' && b.content.trim()))
  if (shows) return
  useChatStore.getState().updateMessageContent(conversationId, messageId, STOPPED_NOTE)
}
