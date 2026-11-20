import { beforeEach, expect, it, vi } from 'vitest'
const backend = vi.hoisted(() => vi.fn())
vi.mock('../../api/backend', () => ({ isTauri: () => true, backendCall: backend }))
import { conversationsToRecover, recoverChatsFromBackup, RECOVERY_DONE_KEY } from '../chat-backup-recovery'
import type { Conversation } from '../../types/chat'

const chat = (id: string, updatedAt: number, messages = 1) =>
  ({ id, title: id, createdAt: 0, updatedAt, messages: Array.from({ length: messages }, (_, i) => ({ id: `${id}${i}`, role: 'user', content: 'x', timestamp: i })) }) as unknown as Conversation
const backupWith = (conversations: Conversation[]) =>
  JSON.stringify({ 'chat-conversations': JSON.stringify({ state: { conversations }, version: 0 }), settings: '{}' })
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }

beforeEach(() => backend.mockReset())

it('brings back chats newer than anything the store kept, and newer copies of kept chats', () => {
  const live = [chat('a', 10), chat('b', 20, 1)]
  const backup = [chat('a', 10), chat('b', 30, 4), chat('lost', 40), chat('deleted-long-ago', 5)]
  expect(conversationsToRecover(live, backup).map(c => c.id)).toEqual(['b', 'lost'])
})

it('never replaces a chat the store has a newer copy of, and ignores malformed entries', () => {
  const live = [chat('a', 50, 3)]
  expect(conversationsToRecover(live, [chat('a', 40, 9), null as unknown as Conversation, { id: 'x' } as Conversation])).toEqual([])
})

it('runs once, hands the chats to the store, and retries after a failure', async () => {
  const storage = memory()
  const add = vi.fn()
  backend.mockRejectedValueOnce(new Error('no backup yet'))
  await expect(recoverChatsFromBackup(() => [chat('a', 10)], add, storage)).rejects.toThrow()
  expect(storage.getItem(RECOVERY_DONE_KEY)).toBeNull()
  backend.mockResolvedValue(backupWith([chat('a', 10), chat('lost', 99)]))
  expect(await recoverChatsFromBackup(() => [chat('a', 10)], add, storage)).toBe(1)
  expect(add.mock.calls[0][0].map((c: Conversation) => c.id)).toEqual(['lost'])
  expect(await recoverChatsFromBackup(() => [chat('a', 10)], add, storage)).toBe(0)
  expect(backend).toHaveBeenCalledTimes(2)
})

it('a backup without chats is fine', async () => {
  backend.mockResolvedValue(JSON.stringify({ settings: '{}' }))
  expect(await recoverChatsFromBackup(() => [], vi.fn(), memory())).toBe(0)
  backend.mockResolvedValue(null)
  expect(await recoverChatsFromBackup(() => [], vi.fn(), memory())).toBe(0)
})
