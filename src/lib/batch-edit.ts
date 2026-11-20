// Several source images, one edit (Discord, 2026-10: "I have a folder
// of images and need them all edited the same"). The same prompt and settings
// run over every image, one after the other. Each image is its own run with its
// own booking, exactly like a single Create, so nothing here knows about money:
// it only decides which image is next and when to stop.
//
// Pure on purpose (no store, no network): the wiring lives in
// components/create/experimental/batchRun.ts, the web twin in the web app.

/** The most source images one batch takes. */
export const MAX_BATCH_IMAGES = 50

/** The tabs that take several source images: Edit, Remove Background and
 *  Enhance Image. Erase Object paints a mask per image and stays single. */
export const BATCH_INTENTS: ReadonlySet<string> = new Set(['edit', 'removebg', 'upscale'])

/** A batch is only offered where a run needs no painted mask, because a mask
 *  belongs to one image. */
export function batchOffered(intent: string, needsMask: boolean): boolean {
  return BATCH_INTENTS.has(intent) && !needsMask
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
}

/** A file read out of a dropped folder can arrive without a type. The name
 *  decides then, and the file gets the type the rest of Create checks. */
function asImageFile(file: File): File | null {
  if (file.type.startsWith('image/')) return file
  if (file.type || !IMAGE_EXT.test(file.name)) return null
  const ext = file.name.split('.').pop()!.toLowerCase()
  return new File([file], file.name, { type: EXT_MIME[ext] ?? 'image/png' })
}

export interface BatchPick {
  /** Images that fit, in name order. */
  accepted: File[]
  /** Files that are not images. */
  skipped: number
  /** Images past the limit. */
  over: number
}

/** Which of the picked files join the batch: images only, sorted by name the
 *  way a folder shows them, and no more than there is room for. */
export function pickBatchFiles(files: readonly File[], room: number): BatchPick {
  const images: File[] = []
  let skipped = 0
  for (const f of files) {
    const img = asImageFile(f)
    if (img) images.push(img)
    else skipped++
  }
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const accepted = images.slice(0, Math.max(0, room))
  return { accepted, skipped, over: images.length - accepted.length }
}

/** What to say about a pick that did not take everything. Null when it did. */
export function batchPickNote(pick: BatchPick): string | null {
  const parts: string[] = []
  if (pick.over > 0 && pick.accepted.length === 0) {
    parts.push(`The list is full. You can edit up to ${MAX_BATCH_IMAGES} images at once.`)
  } else if (pick.over > 0) {
    parts.push(
      `You can edit up to ${MAX_BATCH_IMAGES} images at once. ` +
      `${pick.accepted.length} ${pick.accepted.length === 1 ? 'was' : 'were'} added, ${pick.over} ${pick.over === 1 ? 'was' : 'were'} left out.`,
    )
  }
  if (pick.skipped > 0) {
    parts.push(
      pick.accepted.length === 0 && pick.over === 0
        ? 'That file type is not supported. Use PNG, JPG or WebP.'
        : `${pick.skipped} ${pick.skipped === 1 ? 'file is not an image and was' : 'files are not images and were'} skipped.`,
    )
  }
  return parts.length ? parts.join(' ') : null
}

/** How many of `n` images the credits cover, when one image costs `cost`. */
export function batchCoverage(remaining: number, cost: number, n: number): number {
  if (cost <= 0) return n
  return Math.max(0, Math.min(n, Math.floor(remaining / cost)))
}

/**
 * How many runs per minute a cloud batch starts. The server takes 30 job
 * submits, 60 uploads and 20 Studio quotes per minute and user. A run sends
 * `count` submits, one upload for the source plus one per reference photo, and
 * a Studio run asks one quote. Stays below each limit so a batch is never
 * refused for sending too fast.
 */
export function cloudRunsPerMinute(opts: { count: number; extraPhotos: number; studio: boolean }): number {
  const bySubmit = Math.floor(24 / Math.max(1, opts.count))
  const byUpload = Math.floor(48 / (1 + Math.max(0, opts.extraPhotos)))
  const byQuote = opts.studio ? 10 : Infinity
  return Math.max(1, Math.min(bySubmit, byUpload, byQuote))
}

/** Lets `limit` starts through per window and makes the next one wait. */
export function createPacer(opts: {
  limit: number
  windowMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): { wait: () => Promise<number> } {
  const windowMs = opts.windowMs ?? 60_000
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const starts: number[] = []
  return {
    /** Resolves when the next start is allowed. Returns how long it waited. */
    async wait() {
      let waited = 0
      for (;;) {
        const t = now()
        while (starts.length && t - starts[0] >= windowMs) starts.shift()
        if (starts.length < opts.limit) {
          starts.push(t)
          return waited
        }
        const ms = windowMs - (t - starts[0])
        waited += ms
        await sleep(ms)
      }
    },
  }
}

export type BatchStatus = 'waiting' | 'running' | 'done' | 'failed'

/** What the queue shows while a batch runs. */
export interface BatchRunState {
  /** The image that is running now. */
  index: number
  statuses: BatchStatus[]
  names: string[]
  thumbs: string[]
}

/** Why a batch ended before its last image. */
export type BatchStop =
  | 'cancelled'  // the user hit Cancel
  | 'credits'    // the wallet ran dry
  | 'price'      // the confirmed price was higher than the one shown
  | 'auth'       // signed out
  | 'throttle'   // the server kept saying "too fast"
  | 'changed'    // the tab or the mode changed under the run
  | 'repeated'   // the same error three times in a row

/** One image's run, as the batch sees it. */
export interface RunOutcome {
  /** Results that landed in the gallery. */
  made: number
  /** What the run said went wrong, if anything. */
  error: string | null
  /** The run was refused for a reason that holds for every further image. */
  stop?: 'credits' | 'price' | 'auth' | 'throttle'
  /** With `throttle`: how long the server asked to wait. */
  retryAfterMs?: number
}

export interface BatchReport {
  total: number
  done: number
  failed: { name: string; error: string }[]
  /** Images that made a result and also reported a problem (one of several
   *  results failed). */
  notes: { name: string; error: string }[]
  /** Indexes that have no result: failed ones and ones that never started. */
  pending: number[]
  /** Images that never started. */
  left: number
  stop: BatchStop | null
  stopDetail: string | null
}

const SAME_ERROR_LIMIT = 3
const THROTTLE_RETRIES = 2

/**
 * Runs the images one after the other.
 *
 * One image failing does not stop the others. The batch stops early only when
 * going on makes no sense: Cancel, an empty wallet, a changed price, a sign
 * out, a server that keeps refusing the pace, a changed tab, or the same error
 * three times in a row (an engine that is down fails every image the same way).
 * Whatever did not start is never booked, because it is never sent.
 */
export async function runBatch<T extends { name: string }>(
  entries: readonly T[],
  deps: {
    runOne: (entry: T, index: number) => Promise<RunOutcome>
    cancelled: () => boolean
    /** False once the tab or mode the batch started in is gone. */
    stillValid?: () => boolean
    /** Resolves when the next start is allowed (the send limit). */
    pace?: () => Promise<unknown>
    sleep?: (ms: number) => Promise<void>
    onProgress?: (statuses: BatchStatus[], index: number) => void
  },
): Promise<BatchReport> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const statuses: BatchStatus[] = entries.map(() => 'waiting')
  const failed: BatchReport['failed'] = []
  const notes: BatchReport['notes'] = []
  let done = 0
  let stop: BatchStop | null = null
  let stopDetail: string | null = null
  let lastError: string | null = null
  let sameError = 0

  for (let i = 0; i < entries.length; i++) {
    if (deps.cancelled()) { stop = 'cancelled'; break }
    if (deps.stillValid && !deps.stillValid()) { stop = 'changed'; break }
    await deps.pace?.()
    if (deps.cancelled()) { stop = 'cancelled'; break }

    statuses[i] = 'running'
    deps.onProgress?.([...statuses], i)
    let out = await deps.runOne(entries[i], i)
    // "Too fast" is about the pace, not about this image: wait as long as the
    // server asked and send the same image again.
    for (let retry = 0; out.stop === 'throttle' && out.made === 0 && retry < THROTTLE_RETRIES && !deps.cancelled(); retry++) {
      await sleep(Math.min(60_000, Math.max(1_000, out.retryAfterMs ?? 5_000)))
      if (deps.cancelled()) break
      out = await deps.runOne(entries[i], i)
    }

    if (out.made > 0) {
      statuses[i] = 'done'
      done++
      sameError = 0
      lastError = null
      if (out.error) notes.push({ name: entries[i].name, error: out.error })
    } else if (deps.cancelled()) {
      // A run the user stopped is not a failed image. It stays in the list.
      statuses[i] = 'waiting'
      stop = 'cancelled'
    } else if (out.stop) {
      // Refused before anything was booked, for a reason that is not about
      // this image. It stays in the list like the ones behind it.
      statuses[i] = 'waiting'
    } else {
      const error = out.error ?? 'No result came back.'
      statuses[i] = 'failed'
      failed.push({ name: entries[i].name, error })
      sameError = error === lastError ? sameError + 1 : 1
      lastError = error
    }
    deps.onProgress?.([...statuses], i)

    if (stop) break
    if (out.stop) { stop = out.stop; stopDetail = out.error; break }
    if (sameError >= SAME_ERROR_LIMIT && i < entries.length - 1) { stop = 'repeated'; stopDetail = lastError; break }
  }

  const pending = statuses.flatMap((s, i) => (s === 'done' ? [] : [i]))
  return {
    total: entries.length,
    done,
    failed,
    notes,
    pending,
    left: statuses.filter((s) => s === 'waiting').length,
    stop,
    stopDetail,
  }
}

/** An error text as a closed sentence, so the next one does not run into it. */
function sentence(text: string): string {
  const t = text.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

function nameList(names: string[]): string {
  const shown = names.slice(0, 5).join(', ')
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown
}

/** What to tell the user once a batch ends. Null when every image is done. */
export function batchSummary(r: BatchReport): string | null {
  if (!r.stop && r.failed.length === 0 && r.notes.length === 0) return null
  const parts: string[] = [`${r.done} of ${r.total} images are done.`]
  if (r.failed.length) {
    parts.push(`${r.failed.length} failed: ${nameList(r.failed.map((f) => f.name))}.`)
    if (r.stop !== 'repeated') parts.push(`${r.failed.length === 1 ? 'Error' : 'First error'}: ${sentence(r.failed[0].error)}`)
  }
  if (r.notes.length) parts.push(`${r.notes[0].name}: ${sentence(r.notes[0].error)}`)
  const rest = r.left === 1 ? 'The last image was' : `The other ${r.left} were`
  switch (r.stop) {
    case 'cancelled':
      parts.push(r.left > 0 ? `Stopped. ${rest} not started.` : 'Stopped.')
      break
    case 'credits':
      parts.push(`There were not enough credits to go on. ${rest} not started and nothing was charged for them.`)
      break
    case 'price':
    case 'auth':
    case 'throttle':
      if (r.stopDetail) parts.push(sentence(r.stopDetail))
      parts.push(`${rest} not started.`)
      break
    case 'changed':
      parts.push(`Stopped because the tab or the mode changed. ${rest} not started.`)
      break
    case 'repeated':
      parts.push(`The same error came back ${SAME_ERROR_LIMIT} times, so ${rest.replace(/^The/, 'the')} not started. Error: ${sentence(r.stopDetail ?? 'unknown')}`)
      break
  }
  if (r.pending.length > 0) parts.push('What is left stays ready, hit Create to run it.')
  return parts.join(' ')
}
