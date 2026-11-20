import { afterEach, expect, it, vi } from 'vitest'
import type { Conversation } from '../../types/chat'
const prepared = vi.hoisted(() => vi.fn())
const storage = vi.hoisted(() => ({ getItem: vi.fn(() => null), setItem: vi.fn(async (_key: string, _value: string) => {}), removeItem: vi.fn() }))
vi.mock('../../lib/idbStorage', () => ({ idbStorage: storage, onIdbWrite: vi.fn() }))
vi.mock('../../lib/chat-attachments', async (original) => ({ ...(await original<typeof import('../../lib/chat-attachments')>()), externalizeConversations: prepared }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('migration completion cannot overwrite streamed text, new messages or deleted chats', async () => {
  vi.stubGlobal('indexedDB', {})
  let finish!: () => void
  prepared.mockImplementationOnce((conversations: Conversation[]) => new Promise(resolve => {
    finish = () => resolve(conversations.map(c => ({...c, messages:c.messages.map(m => m.images ? {...m,images:m.images.map(i => ({...i,data:'lu-attachment:v1:stored'}))} : m)})))
  })).mockImplementation(async value => value)
  const { useChatStore, flushChatPersist } = await import('../chatStore')
  await new Promise<void>(resolve => {
    if (useChatStore.persist.hasHydrated()) resolve()
    else { const off = useChatStore.persist.onFinishHydration(() => {off();resolve()}) }
  })
  const store = useChatStore.getState()
  const id = store.createConversation('test', '')
  const gone = store.createConversation('test', '')
  store.addMessage(id, {id:'image',role:'user',content:'photo',timestamp:1,images:[{data:'YWJj',mimeType:'image/png',name:'image'}]})
  store.addMessage(id, {id:'answer',role:'assistant',content:'initial',timestamp:2})
  const saving = flushChatPersist()
  await Promise.resolve()
  store.updateMessageContent(id, 'answer', 'newest streamed text')
  store.addMessage(id, {id:'new',role:'user',content:'new question',timestamp:3})
  store.deleteConversation(gone)
  finish()
  await saving
  const current = useChatStore.getState().conversations.find(c => c.id === id)!
  expect(current.messages.find(m => m.id === 'answer')?.content).toBe('newest streamed text')
  expect(current.messages.at(-1)?.id).toBe('new')
  expect(current.messages[0].images?.[0].data).toBe('lu-attachment:v1:stored')
  expect(useChatStore.getState().conversations.some(c => c.id === gone)).toBe(false)
  const last = JSON.parse(storage.setItem.mock.calls.at(-1)![1])
  expect(last.state.conversations.find((c: Conversation) => c.id === id).messages.at(-1).id).toBe('new')
})
