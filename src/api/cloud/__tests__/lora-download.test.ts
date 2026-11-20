/**
 * Saving a trained cloud character as a file (10.10.2026).
 *
 * The weights are a few hundred megabytes behind a redirect a WebView may not
 * read. So the window never fetches them: it hands the backend the address of
 * the route, the session token and a file name, and the backend streams the
 * file to the place the user picked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  invoke: vi.fn(),
  listeners: [] as Array<(e: { payload: unknown }) => void>,
  unlisten: vi.fn(),
  tauri: true,
}))
vi.mock('../supabase', () => ({ getAccessToken: h.getAccessToken }))
vi.mock('../../backend', () => ({ isTauri: () => h.tauri }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    h.listeners.push(handler)
    return h.unlisten
  }),
}))

import { downloadLora, loraDownloadRefusal } from '../loras'
import { CLOUD_BASE } from '../config'
import { loraFileName } from '../../../lib/render/lora-file-name'

const LORA = { id: '0b9d7c1e-1111-4222-8333-444455556666', name: 'Anna Müller', trigger_word: 'annachar' }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  h.listeners.length = 0
  h.tauri = true
  h.getAccessToken.mockResolvedValue('tok-123')
  vi.stubGlobal('fetch', fetchMock)
})

describe('downloadLora', () => {
  it('hands the backend the route, the session token and a file name, and fetches nothing itself', async () => {
    h.invoke.mockResolvedValue({ status: 'saved', path: '/Users/me/Downloads/Anna-Muller.safetensors', bytes: 300_000_000 })
    await expect(downloadLora(LORA)).resolves.toBe('saved')
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('save_cloud_file_dialog', {
      id: expect.stringMatching(new RegExp(`^lora-${LORA.id}-\\d+$`)),
      url: `${CLOUD_BASE}/api/loras/${LORA.id}/file`,
      authToken: 'tok-123',
      defaultName: 'Anna-Muller.safetensors',
      extension: 'safetensors',
      extLabel: 'Character weights',
    })
    // Not a byte of the file passes through the window.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a closed Save dialog is no error', async () => {
    h.invoke.mockResolvedValue({ status: 'cancelled' })
    await expect(downloadLora(LORA)).resolves.toBe('cancelled')
  })

  it('reports how far its own file is, and stops listening afterwards', async () => {
    const seen: unknown[] = []
    h.invoke.mockImplementation(async (_command: string, args: unknown) => {
      h.listeners[0]({ payload: { id: 'lora-someone-else', received: 9, total: 9 } })
      // An earlier run of the same character is not this download either.
      h.listeners[0]({ payload: { id: `lora-${LORA.id}`, received: 8, total: 8 } })
      h.listeners[0]({ payload: { id: (args as { id: string }).id, received: 50, total: 200 } })
      return { status: 'saved', path: 'x', bytes: 200 }
    })
    await downloadLora(LORA, (p) => seen.push(p))
    expect(seen).toEqual([{ received: 50, total: 200 }])
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('stops listening when the download fails, and passes the reason on', async () => {
    h.invoke.mockRejectedValue('The download broke off before the file was complete. Try again.')
    await expect(downloadLora(LORA, () => {})).rejects.toBe('The download broke off before the file was complete. Try again.')
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  /** A backend that holds the download open until it is cancelled or let go. */
  function pendingBackend() {
    const calls: Array<{ command: string; id: string }> = []
    let end: (answer: unknown) => void = () => {}
    h.invoke.mockImplementation((command: string, args: { id: string }) => {
      calls.push({ command, id: args.id })
      if (command === 'cancel_cloud_file') {
        end({ status: 'stopped' })
        return Promise.resolve(null)
      }
      return new Promise((resolve) => { end = resolve })
    })
    return { calls, finish: (answer: unknown) => end(answer) }
  }

  it('an aborted signal cancels this download in the backend, and the end is "stopped"', async () => {
    const backend = pendingBackend()
    const controller = new AbortController()
    const done = downloadLora(LORA, () => {}, controller.signal)
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1))
    controller.abort()
    await expect(done).resolves.toBe('stopped')
    expect(backend.calls.map((c) => c.command)).toEqual(['save_cloud_file_dialog', 'cancel_cloud_file'])
    // The id of the cancel is the id the download was started with.
    expect(backend.calls[1].id).toBe(backend.calls[0].id)
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('a signal that fires after the download ended cancels nothing', async () => {
    const backend = pendingBackend()
    const controller = new AbortController()
    const done = downloadLora(LORA, () => {}, controller.signal)
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1))
    backend.finish({ status: 'saved', path: 'x', bytes: 1 })
    await expect(done).resolves.toBe('saved')
    controller.abort()
    expect(backend.calls.map((c) => c.command)).toEqual(['save_cloud_file_dialog'])
  })

  it('two downloads of one character carry two ids, so a late cancel cannot end the next one', async () => {
    h.invoke.mockResolvedValue({ status: 'saved', path: 'x', bytes: 1 })
    await downloadLora(LORA)
    await downloadLora(LORA)
    const ids = h.invoke.mock.calls.map((c) => (c[1] as { id: string }).id)
    expect(new Set(ids).size).toBe(2)
  })

  it('an answer of the server instead of the file becomes an English sentence', async () => {
    for (const [code, text] of [
      [401, /signed out of LU Cloud/],
      [404, /no longer on your account/],
      [429, /Too many downloads/],
      [500, /could not prepare the file \(500\)/],
      [400, /could not be loaded \(400\)/],
    ] as const) {
      h.invoke.mockResolvedValue({ status: 'refused', code })
      await expect(downloadLora(LORA)).rejects.toThrow(text)
      expect(loraDownloadRefusal(code)).toMatch(text)
    }
  })

  it('without a session nothing is asked of the backend', async () => {
    h.getAccessToken.mockResolvedValue(null)
    await expect(downloadLora(LORA)).rejects.toThrow(/signed out of LU Cloud/)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('outside the desktop app it says so', async () => {
    h.tauri = false
    await expect(downloadLora(LORA)).rejects.toThrow('Saving a character needs the desktop app.')
    expect(h.invoke).not.toHaveBeenCalled()
  })
})

describe('loraFileName', () => {
  it('is plain ASCII with the right ending and never a path', () => {
    expect(loraFileName('Anna Müller', 'annachar')).toBe('Anna-Muller.safetensors')
    expect(loraFileName('../../etc/passwd', 'x')).toBe('etcpasswd.safetensors')
    expect(loraFileName('  my   hero  ', 'x')).toBe('my-hero.safetensors')
  })

  it('falls back to the trigger word, then to a fixed name', () => {
    expect(loraFileName('日本', 'davechar')).toBe('davechar.safetensors')
    expect(loraFileName('', '')).toBe('character.safetensors')
    expect(loraFileName(undefined, null)).toBe('character.safetensors')
  })
})
