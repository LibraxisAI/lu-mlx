/**
 * The screenshots of computer control, for the user to look at.
 *
 * A card in the conversation shows what LU saw at each step. The pictures
 * are the very ones the model was handed: taken by the guarded capture, with
 * every off limits window already blacked out, and withheld altogether while
 * a password field has the focus. Nothing else ever gets in here.
 *
 * They live in the memory of this window and nowhere else. No store that is
 * written to disk, no chat message, no memory entry holds a picture or a
 * reference that could bring one back: pictures in the chat store are what
 * once filled the app's storage until it ran out of memory. A restart starts
 * with none, and a hard limit on count and bytes drops the oldest first.
 */

import { create } from 'zustand'
import type { PendingFrame } from './frames'

/** Pictures kept at most, over all conversations. */
export const MAX_SCREEN_SHOTS = 24
/** Bytes of picture data kept at most. A screenshot is a JPEG of a few hundred kB. */
export const MAX_SCREEN_SHOT_BYTES = 12 * 1024 * 1024
export const WITHHELD_SHOT_TEXT = 'Not shown: a password field had the focus.'

export interface ScreenShot {
  id: number
  /** The tool call the picture belongs to. */
  callId: string
  /** The frame the model knows it by. Null for a picture that was withheld. */
  frameId: number | null
  /** Where the picture can be shown from. Null when it was withheld. */
  url: string | null
  bytes: number
  /** What happened right before it: "Step 2: Click at 662, 511". */
  caption: string
}

interface ScreenShotState {
  shots: ScreenShot[]
}

/** In memory only. Deliberately without `persist`. */
export const useScreenShotStore = create<ScreenShotState>(() => ({ shots: [] }))

type UrlMaker = { make: (frame: PendingFrame) => string; release: (url: string) => void }

const browserUrls: UrlMaker = {
  make: (frame) => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return `data:${frame.mimeType};base64,${frame.data}`
    const binary = atob(frame.data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: frame.mimeType }))
  },
  release: (url) => {
    if (url.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  },
}

let urls: UrlMaker = browserUrls
let nextId = 1

/** Size of the picture a base64 string holds. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/** Drop from the old end until both limits hold. */
function withinLimits(shots: ScreenShot[]): ScreenShot[] {
  let kept = shots
  let total = kept.reduce((sum, shot) => sum + shot.bytes, 0)
  while (kept.length > 0 && (kept.length > MAX_SCREEN_SHOTS || total > MAX_SCREEN_SHOT_BYTES)) {
    const [oldest, ...rest] = kept
    if (oldest.url) urls.release(oldest.url)
    total -= oldest.bytes
    kept = rest
  }
  return kept
}

function add(shot: Omit<ScreenShot, 'id'>): void {
  useScreenShotStore.setState((state) => ({ shots: withinLimits([...state.shots, { ...shot, id: nextId++ }]) }))
}

/**
 * Keep the picture of one look. `frame` is what was parked for the model, so
 * the user sees exactly what the model was given.
 */
export function keepScreenShot(callId: string | undefined, frameId: number, frame: PendingFrame): void {
  if (!callId) return
  const bytes = base64Bytes(frame.data)
  // One picture larger than the whole budget is not kept at all.
  if (bytes === 0 || bytes > MAX_SCREEN_SHOT_BYTES) return
  add({ callId, frameId, url: urls.make(frame), bytes, caption: 'Screen' })
}

/** A look that gave no picture because a password field had the focus. */
export function noteWithheldScreenShot(callId: string | undefined): void {
  if (!callId) return
  const last = useScreenShotStore.getState().shots.findLast((shot) => shot.callId === callId)
  // One placeholder for a row of looks at the same field.
  if (last && last.url === null) return
  add({ callId, frameId: null, url: null, bytes: 0, caption: WITHHELD_SHOT_TEXT })
}

/** Say what led to a picture. The caption never carries typed text. */
export function captionScreenShot(frameId: number | null, caption: string): void {
  if (frameId === null) return
  useScreenShotStore.setState((state) => {
    if (!state.shots.some((shot) => shot.frameId === frameId)) return state
    return { shots: state.shots.map((shot) => (shot.frameId === frameId ? { ...shot, caption } : shot)) }
  })
}

export function screenShotsOf(callId: string): ScreenShot[] {
  return useScreenShotStore.getState().shots.filter((shot) => shot.callId === callId)
}

export function clearScreenShots(): void {
  for (const shot of useScreenShotStore.getState().shots) if (shot.url) urls.release(shot.url)
  useScreenShotStore.setState({ shots: [] })
}

/** Tests replace the object URLs of the browser. */
export function setScreenShotUrlsForTests(maker: UrlMaker | null): void {
  urls = maker ?? browserUrls
}
