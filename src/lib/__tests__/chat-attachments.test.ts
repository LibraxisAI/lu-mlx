import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
const disk = new Map<string, string>()
const backend = vi.hoisted(() => vi.fn())
const prepare = vi.hoisted(() => vi.fn())
vi.mock('../../api/backend', () => ({ isTauri: () => true, backendCall: backend }))
vi.mock('../chat-image-input', () => ({ prepareChatImage: prepare }))
import {
  __resetAttachmentBackoff, CONTEXT_IMAGE_BUDGET, externalizeConversations, hasInlineImages, OMITTED_IMAGE_NOTE,
  originalAttachment, resolveMessageAttachments, storeAttachment,
} from '../chat-attachments'
import { coalescedJSONStorage } from '../coalescedStorage'
import { portableConversation, parseImportedChats, exportAsJSON, exportConversation, exportAllConversations } from '../chat-export'
import type { Conversation } from '../../types/chat'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  disk.clear()
  __resetAttachmentBackoff()
  prepare.mockReset().mockImplementation(async () => ({ data: 'YWJj', mimeType: 'image/png', name: 'image' }))
  backend.mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === 'write_chat_attachment') { disk.set(args.id, args.data); return }
    if (cmd === 'export_chats_dialog') return { path: '/tmp/out.json', missing: 0 }
    if (!disk.has(args.id)) throw new Error('missing')
    return disk.get(args.id)
  })
})
const image = () => ({ data: 'YWJj', name: 'original.png', mimeType: 'image/png' })
const conversations = () => [{ messages: [{ images: [image()], content: 'hello' }] }]

describe('separate durable chat attachments', () => {
  it('removes inline data without altering originals, and round trips the original bytes', async () => {
    const before = conversations()
    const after = await externalizeConversations(before)
    expect(before[0].messages[0].images[0].data).toBe('YWJj')
    expect(after[0].messages[0].images[0].data).toMatch(/^lu-attachment:v1:[a-f0-9]{64}$/)
    expect(await originalAttachment(after[0].messages[0].images[0])).toEqual(image())
    expect(await externalizeConversations(after)).toBe(after)
    expect(backend.mock.calls.filter(c => c[0] === 'write_chat_attachment')).toHaveLength(1)
  })

  it('does not hash and write the same image object twice', async () => {
    const before = conversations()
    await externalizeConversations(before)
    await externalizeConversations(before)
    expect(backend.mock.calls.filter(c => c[0] === 'write_chat_attachment')).toHaveLength(1)
  })

  it('a failed image write keeps that image inline and never throws', async () => {
    backend.mockRejectedValue(new Error('disk full'))
    const before = conversations()
    const after = await externalizeConversations(before)
    expect(after).toBe(before)
    expect(before[0].messages[0].images[0]).toEqual(image())
    expect(hasInlineImages(after)).toBe(true)
  })

  it('after a failure the next attempts wait instead of hammering a full disk', async () => {
    backend.mockRejectedValueOnce(new Error('disk full'))
    await externalizeConversations(conversations())
    await externalizeConversations(conversations())
    expect(backend).toHaveBeenCalledTimes(1)
    __resetAttachmentBackoff()
    const after = await externalizeConversations(conversations())
    expect(hasInlineImages(after)).toBe(false)
  })

  it('resolves only images retained in a request and leaves stored references alone', async () => {
    const stored = await storeAttachment(image())
    const wire = await resolveMessageAttachments([{ role: 'user', content: 'x', images: [stored] }])
    expect(wire[0].images![0].data).toBe('YWJj')
    expect(stored.data).toMatch(/^lu-attachment:/)
  })

  it('a missing, invalid or undecodable image is left out with a note, the send goes on', async () => {
    const stored = await storeAttachment(image())
    disk.clear()
    const wire = await resolveMessageAttachments([
      { role: 'user', content: 'first', images: [{ ...stored, data: 'lu-attachment:v1:bad/path' }] },
      { role: 'user', content: 'second', images: [stored] },
    ])
    expect(wire[0].images).toBeUndefined()
    expect(wire[0].content).toBe(`first\n\n${OMITTED_IMAGE_NOTE}`)
    expect(wire[1].images).toBeUndefined()
    expect(wire[1].content).toContain(OMITTED_IMAGE_NOTE)
    prepare.mockRejectedValueOnce(new Error('Use a valid PNG'))
    disk.set(stored.data.slice('lu-attachment:v1:'.length), 'YWJj')
    const again = await resolveMessageAttachments([{ role: 'user', content: '', images: [stored] }])
    expect(again[0].content).toBe(OMITTED_IMAGE_NOTE)
  })

  it('over the per-request budget the OLDEST images are left out, never the newest, and it never throws', async () => {
    const big = 'A'.repeat(CONTEXT_IMAGE_BUDGET / 4)
    prepare.mockImplementation(async () => ({ data: big, mimeType: 'image/jpeg', name: 'x' }))
    const stored = await storeAttachment(image())
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `t${i}`, images: [stored] }))
    const wire = await resolveMessageAttachments(turns)
    expect(wire.slice(2).every(m => m.images?.length === 1)).toBe(true)
    expect(wire.slice(0, 2).every(m => !m.images && m.content.endsWith(OMITTED_IMAGE_NOTE))).toBe(true)
  })

  it('an original that stayed inline after a failed write is still prepared before it is sent', async () => {
    const original = { data: 'Q'.repeat(2_000_000), mimeType: 'image/jpeg', name: 'phone.jpg' }
    const wire = await resolveMessageAttachments([{ role: 'user', content: 'x', images: [original] }])
    expect(wire[0].images![0].data).toBe('YWJj')
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('JSON export on desktop hands references to the native writer, never the image bytes', async () => {
    const stored = await storeAttachment(image())
    const conv = { id: 'test', title: 'test', messages: [{ id: 'm', role: 'user', content: 'hello', timestamp: 1, images: [stored] }] } as Conversation
    backend.mockImplementation(async (cmd) => cmd === 'export_chats_dialog' ? { path: '/x.json', missing: 1 } : undefined)
    const one = await exportConversation(conv, 'json')
    expect(one).toEqual({ status: 'saved', path: '/x.json', missing: 1 })
    const all = await exportAllConversations([conv])
    expect(all.status).toBe('saved')
    const exports = backend.mock.calls.filter(call => call[0] === 'export_chats_dialog')
    expect(exports).toHaveLength(2)
    for (const call of exports) {
      expect(call[1].content).toContain(stored.data)
      expect(call[1].content).not.toContain('"YWJj"')
    }
  })

  it('a failing native export is reported, not turned into a broken download', async () => {
    const conv = { id: 'test', title: 'test', messages: [] } as unknown as Conversation
    backend.mockRejectedValue(new Error('Write failed: disk full'))
    const res = await exportAllConversations([conv])
    expect(res.status).toBe('error')
    expect(res.error).toContain('disk full')
  })

  it('exports portable originals that can be imported on another installation', async () => {
    const stored = await storeAttachment(image())
    const conv = { id: 'test', title: 'test', messages: [{ id: 'm', role: 'user', content: 'hello', timestamp: 1, images: [stored] }] } as Conversation
    const portable = await portableConversation(conv)
    const json = exportAsJSON(portable)
    expect(json).not.toContain('lu-attachment:')
    expect(parseImportedChats(json)[0].messages[0].images![0]).toEqual(image())
  })
})

describe('the chat save around the images', () => {
  const state = () => ({ conversations: conversations() })

  it('hydration reads and parses, nothing else: no migration, no write', async () => {
    const setItem = vi.fn()
    const prepareWrite = vi.fn()
    const storage = coalescedJSONStorage({ getItem: () => JSON.stringify({ state: state() }), setItem, removeItem: vi.fn() }, { prepare: prepareWrite })
    expect(await storage.getItem('chats')).toEqual({ state: state() })
    expect(prepareWrite).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('a prepare that throws still writes the chat, every time', async () => {
    const written: string[] = []
    const storage = coalescedJSONStorage<{ text: string }>({ getItem: () => null, setItem: (_k, v) => { written.push(v) }, removeItem: vi.fn() }, {
      waitMs: 0, prepare: async () => { throw new Error('disk full') },
    })
    storage.setItem('chats', { state: { text: 'one' }, version: 0 })
    await storage.flush()
    storage.setItem('chats', { state: { text: 'two' }, version: 0 })
    await storage.flush()
    expect(written.map(v => JSON.parse(v).state.text)).toEqual(['one', 'two'])
  })

  it('a write that fails does not stop the next one', async () => {
    const written: string[] = []
    let fail = true
    const storage = coalescedJSONStorage<{ text: string }>({ getItem: () => null, setItem: (_k, v) => { if (fail) { fail = false; throw new Error('quota') } written.push(v) }, removeItem: vi.fn() }, { waitMs: 0 })
    storage.setItem('chats', { state: { text: 'lost to quota' }, version: 0 })
    await storage.flush()
    storage.setItem('chats', { state: { text: 'kept' }, version: 0 })
    await storage.flush()
    expect(written.map(v => JSON.parse(v).state.text)).toEqual(['kept'])
  })

  it('writes offered before the store is ready are dropped, not written later', async () => {
    const setItem = vi.fn()
    let ready = false
    const storage = coalescedJSONStorage<{ text: string }>({ getItem: () => null, setItem, removeItem: vi.fn() }, { waitMs: 0, ready: () => ready })
    storage.setItem('chats', { state: { text: 'default, before hydration' }, version: 0 })
    await storage.flush()
    await new Promise(r => setTimeout(r, 5))
    expect(setItem).not.toHaveBeenCalled()
    ready = true
    storage.setItem('chats', { state: { text: 'real' }, version: 0 })
    await storage.flush()
    expect(setItem).toHaveBeenCalledOnce()
    expect(JSON.parse(setItem.mock.calls[0][1]).state.text).toBe('real')
  })

  it('prepared() hears only about writes that changed something', async () => {
    const prepared = vi.fn()
    const storage = coalescedJSONStorage<{ text: string }>({ getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, {
      waitMs: 0, prepare: async v => v, prepared,
    })
    storage.setItem('chats', { state: { text: 'x' }, version: 0 })
    await storage.flush()
    expect(prepared).not.toHaveBeenCalled()
  })
})
