/**
 * Several source images, one edit (lib/batch-edit): which files join, how fast
 * a cloud batch sends, and when it stops. Nothing here renders or books.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  MAX_BATCH_IMAGES, batchCoverage, batchOffered, batchPickNote, batchSummary, cloudRunsPerMinute,
  createPacer, pickBatchFiles, runBatch, type RunOutcome,
} from '../batch-edit'

const file = (name: string, type = 'image/png') => new File(['x'], name, { type })
const ok: RunOutcome = { made: 1, error: null }
const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `img-${i + 1}.png` }))
const noWait = { sleep: async () => {} }

describe('where a batch is offered', () => {
  it('Edit, Remove Background and Enhance Image, and only without a mask', () => {
    expect(batchOffered('edit', false)).toBe(true)
    expect(batchOffered('removebg', false)).toBe(true)
    expect(batchOffered('upscale', false)).toBe(true)
    expect(batchOffered('edit', true)).toBe(false)
    expect(batchOffered('eraser', true)).toBe(false)
    expect(batchOffered('image', false)).toBe(false)
    expect(batchOffered('animate', false)).toBe(false)
  })
})

describe('picking files', () => {
  it('takes images in name order and skips everything else', () => {
    const pick = pickBatchFiles([file('b10.png'), file('notes.txt', 'text/plain'), file('b2.png'), file('a.jpg', 'image/jpeg')], 50)
    expect(pick.accepted.map((f) => f.name)).toEqual(['a.jpg', 'b2.png', 'b10.png'])
    expect(pick.skipped).toBe(1)
    expect(pick.over).toBe(0)
  })

  it('a file from a dropped folder without a type counts by its name', () => {
    const pick = pickBatchFiles([file('shot.JPG', ''), file('readme', '')], 50)
    expect(pick.accepted).toHaveLength(1)
    expect(pick.accepted[0].type).toBe('image/jpeg')
    expect(pick.skipped).toBe(1)
  })

  it('stops at the limit and says how many were left out', () => {
    const many = Array.from({ length: 57 }, (_, i) => file(`f${i}.png`))
    const pick = pickBatchFiles(many, MAX_BATCH_IMAGES)
    expect(pick.accepted).toHaveLength(50)
    expect(pick.over).toBe(7)
    expect(batchPickNote(pick)).toBe('You can edit up to 50 images at once. 50 were added, 7 were left out.')
  })

  it('no room left: nothing is added and the note says so', () => {
    const pick = pickBatchFiles([file('a.png')], 0)
    expect(pick.accepted).toHaveLength(0)
    expect(batchPickNote(pick)).toBe('The list is full. You can edit up to 50 images at once.')
  })

  it('only wrong files: the same sentence a single wrong file gets', () => {
    expect(batchPickNote(pickBatchFiles([file('a.pdf', 'application/pdf')], 50))).toBe('That file type is not supported. Use PNG, JPG or WebP.')
  })

  it('a clean pick says nothing', () => {
    expect(batchPickNote(pickBatchFiles([file('a.png'), file('b.png')], 50))).toBeNull()
  })
})

describe('credits and pace', () => {
  it('coverage counts whole images', () => {
    expect(batchCoverage(700, 300, 12)).toBe(2)
    expect(batchCoverage(100, 300, 12)).toBe(0)
    expect(batchCoverage(99999, 300, 12)).toBe(12)
    expect(batchCoverage(0, 0, 5)).toBe(5)
  })

  it('stays under 30 submits, 60 uploads and 20 quotes a minute', () => {
    expect(cloudRunsPerMinute({ count: 1, extraPhotos: 0, studio: false })).toBe(24)
    expect(cloudRunsPerMinute({ count: 4, extraPhotos: 0, studio: false })).toBe(6)
    expect(cloudRunsPerMinute({ count: 1, extraPhotos: 4, studio: false })).toBe(9)
    expect(cloudRunsPerMinute({ count: 1, extraPhotos: 0, studio: true })).toBe(10)
    for (const count of [1, 2, 3, 4]) {
      for (const extraPhotos of [0, 1, 2, 3, 4]) {
        const runs = cloudRunsPerMinute({ count, extraPhotos, studio: true })
        expect(runs * count).toBeLessThanOrEqual(30)
        expect(runs * (1 + extraPhotos)).toBeLessThanOrEqual(60)
        expect(runs).toBeLessThanOrEqual(20)
      }
    }
  })

  it('the pacer lets the limit through and makes the next start wait for the window', async () => {
    let now = 0
    const slept: number[] = []
    const pacer = createPacer({ limit: 2, windowMs: 60_000, now: () => now, sleep: async (ms) => { slept.push(ms); now += ms } })
    expect(await pacer.wait()).toBe(0)
    now = 10_000
    expect(await pacer.wait()).toBe(0)
    now = 15_000
    expect(await pacer.wait()).toBe(45_000)
    expect(slept).toEqual([45_000])
    expect(now).toBe(60_000)
  })
})

describe('running the list', () => {
  it('one failing image does not stop the others and is named at the end', async () => {
    const runOne = vi.fn(async (e: { name: string }): Promise<RunOutcome> =>
      e.name === 'img-2.png' ? { made: 0, error: 'provider said no' } : ok)
    const r = await runBatch(entries(4), { runOne, cancelled: () => false, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(4)
    expect(r.done).toBe(3)
    expect(r.failed).toEqual([{ name: 'img-2.png', error: 'provider said no' }])
    expect(r.pending).toEqual([1])
    expect(r.stop).toBeNull()
    expect(batchSummary(r)).toBe('3 of 4 images are done. 1 failed: img-2.png. Error: provider said no. What is left stays ready, hit Create to run it.')
  })

  it('all done: nothing to say', async () => {
    const r = await runBatch(entries(3), { runOne: async () => ok, cancelled: () => false, ...noWait })
    expect(r.done).toBe(3)
    expect(r.pending).toEqual([])
    expect(batchSummary(r)).toBeNull()
  })

  it('Cancel stops the rest, and the image that was cancelled is not a failure', async () => {
    let stop = false
    const runOne = vi.fn(async (_e: unknown, i: number): Promise<RunOutcome> => {
      if (i === 1) { stop = true; return { made: 0, error: null } }
      return ok
    })
    const r = await runBatch(entries(5), { runOne, cancelled: () => stop, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(2)
    expect(r.done).toBe(1)
    expect(r.failed).toEqual([])
    expect(r.stop).toBe('cancelled')
    expect(r.left).toBe(4)
    expect(r.pending).toEqual([1, 2, 3, 4])
    expect(batchSummary(r)).toBe('1 of 5 images are done. Stopped. The other 4 were not started. What is left stays ready, hit Create to run it.')
  })

  it('a run that could not be stopped still counts when its result lands', async () => {
    let stop = false
    const runOne = vi.fn(async (): Promise<RunOutcome> => { stop = true; return { made: 1, error: 'This render already started.' } })
    const r = await runBatch(entries(3), { runOne, cancelled: () => stop, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(1)
    expect(r.done).toBe(1)
    expect(r.stop).toBe('cancelled')
    expect(r.pending).toEqual([1, 2])
  })

  it('credits run out: the rest never starts', async () => {
    const runOne = vi.fn(async (_e: unknown, i: number): Promise<RunOutcome> =>
      i < 2 ? ok : { made: 0, error: "You're out of credits.", stop: 'credits' })
    const r = await runBatch(entries(6), { runOne, cancelled: () => false, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(3)
    expect(r.done).toBe(2)
    expect(r.failed).toEqual([])
    expect(r.stop).toBe('credits')
    expect(r.left).toBe(4)
    expect(batchSummary(r)).toBe('2 of 6 images are done. There were not enough credits to go on. The other 4 were not started and nothing was charged for them. What is left stays ready, hit Create to run it.')
  })

  it('credits run out inside a run with several results: what landed counts, the rest stops', async () => {
    const runOne = vi.fn(async (): Promise<RunOutcome> => ({ made: 2, error: 'Started 2 of 4 images.', stop: 'credits' }))
    const r = await runBatch(entries(3), { runOne, cancelled: () => false, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(1)
    expect(r.done).toBe(1)
    expect(r.notes).toEqual([{ name: 'img-1.png', error: 'Started 2 of 4 images.' }])
    expect(r.stop).toBe('credits')
    expect(r.pending).toEqual([1, 2])
  })

  it('a changed price stops the batch and shows the new price', async () => {
    const msg = 'The price changed to 5,000 credits. Review it, then hit Create again.'
    const r = await runBatch(entries(3), { runOne: async () => ({ made: 0, error: msg, stop: 'price' }), cancelled: () => false, ...noWait })
    expect(r.stop).toBe('price')
    expect(r.done).toBe(0)
    expect(batchSummary(r)).toBe(`0 of 3 images are done. ${msg} The other 3 were not started. What is left stays ready, hit Create to run it.`)
  })

  it('"too fast" waits as long as the server asked and sends the same image again', async () => {
    const slept: number[] = []
    let calls = 0
    const runOne = vi.fn(async (): Promise<RunOutcome> => (++calls === 1 ? { made: 0, error: 'Too many requests at once.', stop: 'throttle', retryAfterMs: 12_000 } : ok))
    const r = await runBatch(entries(2), { runOne, cancelled: () => false, sleep: async (ms) => { slept.push(ms) } })
    expect(slept).toEqual([12_000])
    expect(runOne).toHaveBeenCalledTimes(3)
    expect(r.done).toBe(2)
    expect(r.stop).toBeNull()
  })

  it('a server that keeps saying "too fast" ends the batch after two more tries', async () => {
    const runOne = vi.fn(async (): Promise<RunOutcome> => ({ made: 0, error: 'Too many requests at once.', stop: 'throttle' }))
    const r = await runBatch(entries(4), { runOne, cancelled: () => false, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(3)
    expect(r.stop).toBe('throttle')
    expect(r.failed).toEqual([])
    expect(r.left).toBe(4)
  })

  it('the same error three times in a row stops the rest', async () => {
    const runOne = vi.fn(async (): Promise<RunOutcome> => ({ made: 0, error: 'ComfyUI is not running.' }))
    const r = await runBatch(entries(8), { runOne, cancelled: () => false, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(3)
    expect(r.stop).toBe('repeated')
    expect(r.failed).toHaveLength(3)
    expect(r.left).toBe(5)
    expect(batchSummary(r)).toBe('0 of 8 images are done. 3 failed: img-1.png, img-2.png, img-3.png. The same error came back 3 times, so the other 5 were not started. Error: ComfyUI is not running. What is left stays ready, hit Create to run it.')
  })

  it('different errors do not count as the same one', async () => {
    const runOne = vi.fn(async (_e: unknown, i: number): Promise<RunOutcome> => ({ made: 0, error: `error ${i}` }))
    const r = await runBatch(entries(5), { runOne, cancelled: () => false, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(5)
    expect(r.stop).toBeNull()
  })

  it('a changed tab ends the batch before the next image', async () => {
    let valid = true
    const runOne = vi.fn(async (): Promise<RunOutcome> => { valid = false; return ok })
    const r = await runBatch(entries(3), { runOne, cancelled: () => false, stillValid: () => valid, ...noWait })
    expect(runOne).toHaveBeenCalledTimes(1)
    expect(r.stop).toBe('changed')
  })

  it('waits for the pace before every start and reports the queue', async () => {
    const pace = vi.fn(async () => {})
    const seen: string[] = []
    await runBatch(entries(2), {
      runOne: async () => ok, cancelled: () => false, pace, ...noWait,
      onProgress: (statuses, index) => seen.push(`${index}:${statuses.join(',')}`),
    })
    expect(pace).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['0:running,waiting', '0:done,waiting', '1:done,running', '1:done,done'])
  })

  it('names at most five failed files', async () => {
    const r = await runBatch(entries(7), { runOne: async (_e, i) => ({ made: 0, error: `e${i}` }), cancelled: () => false, ...noWait })
    expect(batchSummary(r)).toContain('7 failed: img-1.png, img-2.png, img-3.png, img-4.png, img-5.png and 2 more.')
  })
})
