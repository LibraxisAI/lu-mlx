// Saving a result of Create in chat to disk.
//
// The web's order card fetches the file and clicks a blob link. A WebView does
// not save from a blob link (WebView2 does nothing at all), so the card uses
// the app's own way here: the same native Save dialog as the Create tab's
// gallery (galleryDownload.ts, saveBytes).
import { extFor, saveBytes } from '../../create/experimental/galleryDownload'
import { useChatNoticeStore, CHAT_NOTICE_MS } from '../../../stores/chatNoticeStore'

const KIND: Record<string, 'image' | 'video' | 'audio'> = { png: 'image', mp4: 'video', mp3: 'audio' }

/** `name` is the card's file name ("neon-city.png"); the extension follows
 *  what the server really sent. A failure says so in the line above the
 *  thread, never in or over the composer. */
export async function saveChatMedia(url: string, name: string): Promise<void> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`the file could not be loaded (${res.status})`)
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = extFor(res.headers.get('content-type') ?? '', KIND[dot > 0 ? name.slice(dot + 1) : ''] ?? 'image')
    await saveBytes(new Uint8Array(await res.arrayBuffer()), `${base}.${ext}`, ext)
  } catch (err) {
    useChatNoticeStore.getState().show(
      'create-save',
      `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      'fehler',
      CHAT_NOTICE_MS,
    )
  }
}
