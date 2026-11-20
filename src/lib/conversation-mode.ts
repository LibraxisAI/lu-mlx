/**
 * The chat mode a conversation runs under, with the legacy default applied.
 *
 * `Conversation.mode` (src/types/chat.ts) is optional. It was introduced on
 * 2026-04-05 (5382d831); every conversation saved before that date has no
 * `mode` field at all, `migratePersistedChat` (chatStore.ts) does not add one
 * on load, and the store deliberately has no version/migrate step. Imported
 * conversations are the same story: `chatbot-export.ts` builds Conversation
 * objects with no `mode` field either.
 *
 * The house rule for an absent `mode` has always been "treat it as `lu`"
 * (RecentChats.tsx originally, `(c.mode ?? 'lu') === 'lu'`). Review Teil 15
 * found that rule re-implemented ad hoc in ChatView.tsx and, in one spot,
 * dropped: `conv.mode !== 'lu' && conv.mode !== 'remote'` reads `false` for
 * `undefined`, so a pre-migration or imported conversation with no messages
 * showed a blank main area instead of the empty-state landing block. One
 * reader here keeps that rule in exactly one place.
 */

import type { Conversation } from '../types/chat'

/** The conversation shape this needs. Kept structural, like
 *  conversation-model.ts, so a partial conversation can ask too. */
export interface ConversationModeSource {
  mode?: Conversation['mode']
}

/** `conv.mode`, defaulted to `'lu'` for a conversation that predates the
 *  field or came in through an importer that never set it. */
export function conversationMode(
  conv: ConversationModeSource | null | undefined,
): NonNullable<Conversation['mode']> {
  return conv?.mode ?? 'lu'
}

/**
 * The conversation that may stay active when the app starts.
 *
 * The app always starts in the Chat tab (codexStore resets chatMode to 'lu'
 * on every rehydrate, a product decision), while the active conversation id
 * is persisted. When the last conversation was a Code one, the Chat tab
 * rendered it as a plain chat with Agent off, and a "continue" typed there
 * went out without any tools (Gegenprobe on the real build, 30.09.2026). A
 * conversation that belongs to another tab therefore does not survive the
 * start; the app opens on the chat worked on last instead, so a returning
 * user is where they left the Chat tab (Gegenprobe 01.10.2026: it opened
 * empty). Nothing active stays nothing active, and so does a newcomer.
 */
export function activeConversationAtStart(
  conversations: ReadonlyArray<{ id: string; updatedAt?: number } & ConversationModeSource>,
  activeId: string | null | undefined,
): string | null {
  if (!activeId) return null
  const conv = conversations.find((c) => c.id === activeId)
  if (conv && conversationMode(conv) === 'lu') return activeId
  return latestConversationOfMode(conversations, 'lu')
}

/**
 * The conversation the Code button (mode 'codex') and the Chat button (mode
 * 'lu') return to: the one worked on last. For Chat since 01.10.2026: Chat,
 * Code, Chat landed on an empty page while the chat was one click away.
 * "New Chat" is the way to an empty one.
 * The button used to clear the active conversation, so going to Chat and
 * back to Code while a run was in flight landed on the empty start page and
 * the running conversation had to be found in the list.
 */
export function latestConversationOfMode(
  conversations: ReadonlyArray<{ id: string; updatedAt?: number } & ConversationModeSource>,
  mode: NonNullable<Conversation['mode']>,
): string | null {
  let best: { id: string; updatedAt?: number } | null = null
  for (const c of conversations) {
    if (conversationMode(c) !== mode) continue
    if (!best || (c.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = c
  }
  return best?.id ?? null
}
