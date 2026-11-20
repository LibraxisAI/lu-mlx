// MIRRORED from the web app (lib/create/chat-attachments.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
import { INPUT_MAX_BYTES } from '../render/input-limit'
import type { MediaAttachment } from '../../types/chat'

export interface PendingMedia extends MediaAttachment {
  blob: Blob
}

export const ATTACH_MAX_BYTES = INPUT_MAX_BYTES

export const ATTACH_TOO_LARGE =
  `This file is larger than ${ATTACH_MAX_BYTES / 1024 / 1024} MB. Trim or compress it, or use a result from your gallery.`

export const ATTACH_ACCEPT_IMAGES = 'image/*'
export const ATTACH_ACCEPT_CREATE =
  'image/*,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/flac,audio/mp4,audio/x-m4a,.mp3,.wav,.ogg,.flac,.m4a,.mp4,.webm,.mov'

export function mediaKindOf(file: { type: string; name: string }): 'video' | 'audio' | null {
  const type = (file.type || '').toLowerCase()
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (type.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video'
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio'
  return null
}

export function tooLargeToAttach(file: { size: number }): boolean {
  return file.size > ATTACH_MAX_BYTES
}

export const MAX_MEDIA_PER_MESSAGE = 3

export const ATTACH_TOO_MANY =
  `A message takes up to ${MAX_MEDIA_PER_MESSAGE} clips or sound tracks. The rest was not attached.`

export function addPendingMedia(current: PendingMedia[], picked: PendingMedia[]): { media: PendingMedia[]; dropped: boolean } {
  const all = [...current, ...picked]
  return { media: all.slice(0, MAX_MEDIA_PER_MESSAGE), dropped: all.length > MAX_MEDIA_PER_MESSAGE }
}

const blobs = new Map<string, Blob[]>()

export function registerMessageMedia(messageId: string, files: Blob[]): void {
  if (files.length) blobs.set(messageId, files)
}

export function messageMediaBlob(messageId: string, index: number): Blob | undefined {
  return blobs.get(messageId)?.[index]
}

export function clearMessageMedia(): void {
  blobs.clear()
}

export function attachmentNote(images: { name: string }[], media: MediaAttachment[]): string {
  const parts = [
    ...images.map((i) => `image "${i.name}"`),
    ...media.map((m) => `${m.kind === 'video' ? 'clip' : 'sound track'} "${m.name}"`),
  ]
  if (!parts.length) return ''
  return `${ATTACHMENT_NOTE_START}${parts.join(', ')}. create_options lists the handle of each attachment.]`
}

const ATTACHMENT_NOTE_START = '[Attached for Create: '

export function textWithoutAttachmentNote(message: { content: string; displayContent?: string }): string {
  const shown = message.displayContent
  if (shown !== undefined && message.content.startsWith(`${shown}\n\n${ATTACHMENT_NOTE_START}`)) return shown
  return message.content
}

export function pendingMediaOf(message: { id: string; media?: MediaAttachment[] }): PendingMedia[] {
  const out: PendingMedia[] = []
  ;(message.media ?? []).forEach((m, i) => {
    const blob = messageMediaBlob(message.id, i)
    if (blob) out.push({ ...m, blob })
  })
  return out
}

export function sendImagesToModel(createTools: boolean, modelSeesImages: boolean): boolean {
  return !createTools || modelSeesImages
}
