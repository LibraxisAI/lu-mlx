// MIRRORED from the web app (lib/create/handles.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
export type MediaKind = 'image' | 'video' | 'audio'

export const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface HandleResult {
  jobId: string
  kind: MediaKind
  createdAt: number
  title: string
}

export interface HandleGalleryEntry {
  id: string
  jobId?: string
  kind: MediaKind
  remoteUrl?: string
  createdAt: number
  title: string
}

export interface HandleAttachment {
  messageId: string
  index: number
  mimeType: string
  name: string
  kind?: MediaKind
  data?: string
  blob?: Blob
}

export const attachmentKind = (a: HandleAttachment): MediaKind => a.kind ?? 'image'
export const attachmentUsable = (a: HandleAttachment): boolean => (attachmentKind(a) === 'image' ? !!a.data : !!a.blob)

export interface HandleItem {
  n: number
  kind: MediaKind
  title: string
}

export interface HandleContext {
  results: HandleResult[]
  gallery: HandleGalleryEntry[]
  attachments: HandleAttachment[]
  items?: HandleItem[]
  now: number
}

export type HandleRef =
  | { type: 'job'; jobId: string }
  | { type: 'dataUrl'; url: string }
  | { type: 'blob'; blob: Blob }
  | { type: 'item'; n: number }

export interface ResolvedHandle {
  handle: string
  kind: MediaKind
  title: string
  ref: HandleRef
}

export class HandleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandleError'
  }
}

const SHORT = 8

export function shortId(id: string): string {
  return id.slice(0, SHORT)
}

export const resultHandle = (jobId: string) => `job:${shortId(jobId)}`
export const galleryHandle = (entry: Pick<HandleGalleryEntry, 'id' | 'jobId'>) => `gal:${shortId(entry.jobId ?? entry.id)}`
export const attachmentHandle = (messageId: string, index: number) => `att:${shortId(messageId)}:${index}`
export const itemHandle = (n: number) => `item:${n}`

function isCloud(entry: HandleGalleryEntry): boolean {
  return !!entry.remoteUrl && !!(entry.jobId ?? entry.id)
}

function expired(createdAt: number, now: number): boolean {
  return now - createdAt > RESULT_TTL_MS
}

export function usableGallery(ctx: HandleContext): HandleGalleryEntry[] {
  const own = new Set(ctx.results.map((r) => r.jobId))
  return ctx.gallery.filter((g) => isCloud(g) && !expired(g.createdAt, ctx.now) && !own.has(g.jobId ?? g.id))
}

export function usableResults(ctx: HandleContext): HandleResult[] {
  return ctx.results.filter((r) => !expired(r.createdAt, ctx.now))
}

export function validHandles(ctx: HandleContext, kind?: MediaKind): string[] {
  const out: string[] = []
  for (const item of ctx.items ?? []) if (!kind || item.kind === kind) out.push(itemHandle(item.n))
  for (const r of usableResults(ctx)) if (!kind || r.kind === kind) out.push(resultHandle(r.jobId))
  for (const g of usableGallery(ctx)) if (!kind || g.kind === kind) out.push(galleryHandle(g))
  for (const a of ctx.attachments) {
    if (attachmentUsable(a) && (!kind || attachmentKind(a) === kind)) out.push(attachmentHandle(a.messageId, a.index))
  }
  return out
}

export function validHandlesText(ctx: HandleContext, kind?: MediaKind): string {
  const all = validHandles(ctx, kind)
  if (!all.length) {
    return kind
      ? `There is no ${kind} to use yet.`
      : 'There are no results, gallery entries or attachments to use yet.'
  }
  const shown = all.slice(0, 12)
  return `Valid${kind ? ` ${kind}` : ''} handles: ${shown.join(', ')}${all.length > shown.length ? ', ...' : ''}.`
}

function byPrefix<T>(list: T[], id: (t: T) => string, want: string): T | undefined | 'ambiguous' {
  const hits = list.filter((t) => {
    const full = id(t)
    return full === want || (want.length >= SHORT && full.startsWith(want))
  })
  if (hits.length > 1) return 'ambiguous'
  return hits[0]
}

const FORMS = 'Use job:<id>, gal:<id>, att:<message>:<n> or item:<n>.'

export function resolveHandle(raw: unknown, ctx: HandleContext): ResolvedHandle {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const match = /^(job|gal|att|item):(.+)$/.exec(text)
  if (!match) {
    const named = text ? ctx.attachments.filter((a) => attachmentUsable(a) && a.name === text) : []
    if (named.length === 1) return resolveHandle(attachmentHandle(named[0].messageId, named[0].index), ctx)
    throw new HandleError(`"${shown}" is not a handle. ${FORMS} ${validHandlesText(ctx)}`)
  }
  const [, scheme, rest] = match
  const unknown = () => new HandleError(`Unknown handle "${text}". ${validHandlesText(ctx)}`)

  if (scheme === 'item') {
    const n = Number(rest)
    const item = Number.isInteger(n) ? ctx.items?.find((i) => i.n === n) : undefined
    if (!item) {
      throw new HandleError(`"${text}" is not an earlier item of this order. ${validHandlesText(ctx)}`)
    }
    return { handle: itemHandle(n), kind: item.kind, title: item.title, ref: { type: 'item', n } }
  }

  if (scheme === 'att') {
    const parts = /^([^:]+):(\d+)$/.exec(rest)
    if (!parts) throw new HandleError(`"${text}" is not an attachment handle. Use att:<message>:<n>. ${validHandlesText(ctx)}`)
    const [, message, index] = parts
    const ofMessage = ctx.attachments.filter((a) => a.messageId === message || (message.length >= SHORT && a.messageId.startsWith(message)))
    const ids = new Set(ofMessage.map((a) => a.messageId))
    if (ids.size > 1) throw new HandleError(`"${text}" matches more than one message. ${validHandlesText(ctx)}`)
    if (!ofMessage.length) throw unknown()
    const att = ofMessage.find((a) => a.index === Number(index))
    if (!att) {
      throw new HandleError(
        `"${text}" does not exist: that message has ${ofMessage.length === 1 ? '1 attachment' : `${ofMessage.length} attachments`}. `
        + validHandlesText(ctx),
      )
    }
    if (!attachmentUsable(att)) {
      throw new HandleError(
        `"${text}" is no longer available: an attached clip or sound track is only kept while the page stays open. `
        + `Ask the customer to attach the file again. ${validHandlesText(ctx)}`,
      )
    }
    return {
      handle: attachmentHandle(att.messageId, att.index),
      kind: attachmentKind(att),
      title: att.name,
      ref: att.blob && attachmentKind(att) !== 'image'
        ? { type: 'blob', blob: att.blob }
        : { type: 'dataUrl', url: `data:${att.mimeType};base64,${att.data}` },
    }
  }

  if (scheme === 'job') {
    const hit = byPrefix(ctx.results, (r) => r.jobId, rest)
    if (hit === 'ambiguous') throw new HandleError(`"${text}" matches more than one result. ${validHandlesText(ctx)}`)
    if (!hit) throw unknown()
    if (expired(hit.createdAt, ctx.now)) {
      throw new HandleError(`"${text}" has expired: results are kept for 7 days. ${validHandlesText(ctx)}`)
    }
    return { handle: resultHandle(hit.jobId), kind: hit.kind, title: hit.title, ref: { type: 'job', jobId: hit.jobId } }
  }

  const hit = byPrefix(ctx.gallery, (g) => g.jobId ?? g.id, rest)
  if (hit === 'ambiguous') throw new HandleError(`"${text}" matches more than one gallery entry. ${validHandlesText(ctx)}`)
  if (!hit) throw unknown()
  if (!isCloud(hit)) {
    throw new HandleError(`"${text}" is a local result and cannot be used in the cloud. ${validHandlesText(ctx)}`)
  }
  if (expired(hit.createdAt, ctx.now)) {
    throw new HandleError(`"${text}" has expired: results are kept for 7 days. ${validHandlesText(ctx)}`)
  }
  const jobId = hit.jobId ?? hit.id
  return { handle: galleryHandle(hit), kind: hit.kind, title: hit.title, ref: { type: 'job', jobId } }
}
