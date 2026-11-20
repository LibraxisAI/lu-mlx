/**
 * Screenshots on their way to the model.
 *
 * A tool result is text. The picture travels the way generated images do: as
 * a follow-up message with an attachment (api/vision-feedback.ts). The tool
 * parks the picture here under its frame id and names that id in its result;
 * the agent loop picks it up once. Nothing here is persisted, and only the
 * newest pictures are kept.
 */

export interface PendingFrame {
  data: string
  mimeType: string
}

const KEEP = 2
const frames = new Map<number, PendingFrame>()

export function parkFrame(frameId: number, frame: PendingFrame): void {
  frames.set(frameId, frame)
  while (frames.size > KEEP) {
    const oldest = frames.keys().next().value
    if (oldest === undefined) break
    frames.delete(oldest)
  }
}

/** Hand the picture out once. */
export function takeFrame(frameId: number): PendingFrame | null {
  const frame = frames.get(frameId) ?? null
  frames.delete(frameId)
  return frame
}

export function clearFrames(): void {
  frames.clear()
}

const MARKER = /\[screen frame (\d+)\]/g

export function frameMarker(frameId: number): string {
  return `[screen frame ${frameId}]`
}

/** The newest frame a tool result names, or null. */
export function frameIdInResult(result: string): number | null {
  let last: number | null = null
  for (const match of result.matchAll(MARKER)) last = Number(match[1])
  return last
}
