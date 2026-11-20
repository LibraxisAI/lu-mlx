import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { Conversation } from '../../types/chat'

// A history saved before the attachment store: every image inline. The chat
// store must not write ANYTHING until that history is in memory, must never
// write a state without it, and must move the images out on its own once it
// has loaded, through the ordinary write path.
const read = vi.hoisted(() => ({ resolve: (_: string | null) => {} }))
const storage = vi.hoisted(() => ({
  getItem: vi.fn(() => new Promise<string | null>(resolve => { read.resolve = resolve })),
  setItem: vi.fn(async (_key: string, _value: string) => {}),
  removeItem: vi.fn(),
}))
const externalize = vi.hoisted(() => vi.fn())
vi.mock('../../lib/idbStorage', () => ({ idbStorage: storage, onIdbWrite: vi.fn() }))
vi.mock('../../lib/chat-attachments', async (original) => ({
  ...(await original<typeof import('../../lib/chat-attachments')>()),
  externalizeConversations: externalize,
}))

const legacy = (images: boolean) => JSON.stringify({
  state: {
    conversations: [{
      id: 'old', title: 'old chat', createdAt: 1, updatedAt: 1, messages: [
        { id: 'p', role: 'user', content: 'photo', timestamp: 1, ...(images ? { images: [{ data: 'YWJj', mimeType: 'image/png', name: 'p.png' }] } : {}) },
        { id: 'a', role: 'assistant', content: 'nice', timestamp: 2 },
      ],
    }],
    activeConversationId: 'old',
  },
  version: 0,
})

// Every test loads a fresh chat store, and the first load of that module
// graph is the one that costs: 4.4 s measured on a loaded machine against
// 10 ms for each later one. Inside the first test that load ate its five
// seconds (red three times in full runs on 08.10.2026). It is paid here, once,
// outside any test, so the tests time the store and not the transform.
beforeAll(async () => {
  vi.stubGlobal('indexedDB', {})
  await import('../chatStore')
  vi.unstubAllGlobals()
}, 120_000)

beforeEach(() => {
  vi.resetModules()
  // The store waits on timers only (coalesced writes), so the tests move the
  // clock themselves. A real 400 ms wait is not long enough on a loaded
  // machine and is 400 ms too long on an idle one.
  vi.useFakeTimers()
  vi.stubGlobal('indexedDB', {})
  storage.setItem.mockClear()
  // Same contract as the real one: the identical array back when nothing moved.
  externalize.mockReset().mockImplementation(async (conversations: Conversation[]) => {
    const inline = (m: Conversation['messages'][number]) => m.images?.some(i => !i.data.startsWith('lu-attachment:'))
    if (!conversations.some(c => c.messages.some(inline))) return conversations
    return conversations.map(c => ({
      ...c, messages: c.messages.map(m => inline(m) ? { ...m, images: m.images!.map(i => ({ ...i, data: 'lu-attachment:v1:' + 'a'.repeat(64) })) } : m),
    }))
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const settle = () => vi.advanceTimersByTimeAsync(400)
const written = () => storage.setItem.mock.calls.map(c => JSON.parse(c[1]).state.conversations as Conversation[])

it('writes nothing while hydration is still reading, whatever the app does meanwhile', async () => {
  const { useChatStore, flushChatPersist } = await import('../chatStore')
  const { isBackupHeld } = await import('../../lib/backup-hold')
  // What the app really does at launch: the model store writes the active
  // chat's model (modelStore.ts), a new chat may be created.
  useChatStore.getState().setActiveConversationModel?.('some-model')
  useChatStore.getState().createConversation('m', '')
  await flushChatPersist()
  await settle()
  expect(storage.setItem).not.toHaveBeenCalled()
  expect(isBackupHeld()).toBe(true)
  read.resolve(legacy(true))
  await settle()
  expect(useChatStore.persist.hasHydrated()).toBe(true)
  // Every write that ever happened carries the old chat.
  expect(written().length).toBeGreaterThan(0)
  for (const conversations of written()) expect(conversations.some(c => c.id === 'old')).toBe(true)
})

it('after hydration the images move out by themselves, the text is untouched, the backup is released', async () => {
  const { useChatStore } = await import('../chatStore')
  const { isBackupHeld } = await import('../../lib/backup-hold')
  read.resolve(legacy(true))
  await settle()
  expect(externalize).toHaveBeenCalled()
  const last = written().at(-1)!
  const old = last.find(c => c.id === 'old')!
  expect(old.messages[0].images![0].data).toMatch(/^lu-attachment:v1:/)
  expect(old.messages.map(m => m.content)).toEqual(['photo', 'nice'])
  expect(JSON.stringify(last)).not.toContain('YWJj')
  // The live state swapped to the references too, so no later write carries
  // the inline bytes again.
  expect(useChatStore.getState().conversations[0].messages[0].images![0].data).toMatch(/^lu-attachment:v1:/)
  expect(isBackupHeld()).toBe(false)
})

it('a history without inline images is not rewritten at launch and releases the backup at once', async () => {
  await import('../chatStore')
  const { isBackupHeld } = await import('../../lib/backup-hold')
  read.resolve(legacy(false))
  await settle()
  expect(storage.setItem).not.toHaveBeenCalled()
  expect(externalize).not.toHaveBeenCalled()
  expect(isBackupHeld()).toBe(false)
})

it('when every attachment write fails, the chat is still saved (inline) and the backup is released', async () => {
  externalize.mockReset().mockImplementation(async (conversations: Conversation[]) => conversations)
  const { useChatStore } = await import('../chatStore')
  const { isBackupHeld } = await import('../../lib/backup-hold')
  read.resolve(legacy(true))
  await settle()
  useChatStore.getState().addMessage('old', { id: 'n', role: 'user', content: 'typed after the failure', timestamp: 3 })
  await settle()
  const last = written().at(-1)!
  expect(last[0].messages.at(-1)!.content).toBe('typed after the failure')
  expect(last[0].messages[0].images![0].data).toBe('YWJj')
  expect(isBackupHeld()).toBe(false)
})
