import { describe, expect, it } from 'vitest'
import {
  FIRST_SPEECH_GUARD_MAX_SECS, FIRST_SPEECH_GUARD_SECS, FirstSpeechGuard, HELD_MIC_SECS, HELD_MIC_SPEED, HeldAudio, heldChunksDue,
  SETTLE_TONE_GAIN, SETTLE_TONE_HZ, SETTLE_TONE_SECS,
} from '../mic-start'

describe('the settle tone', () => {
  it('is below hearing and long enough for the echo cancellation', () => {
    // Measured with a silent microphone, ten sessions each: 3.5 s at -42 dBFS 1 of 10,
    // 6 s at -42 dBFS 8 of 10, 6 s at -36 dBFS 10 of 10.
    expect(SETTLE_TONE_SECS).toBeGreaterThanOrEqual(6)
    // It also turns a weak voice down while it plays, so it must not run long.
    expect(SETTLE_TONE_SECS).toBeLessThanOrEqual(8)
    expect(SETTLE_TONE_HZ).toBeLessThanOrEqual(25)
    const dbfs = 20 * Math.log10(SETTLE_TONE_GAIN)
    expect(dbfs).toBeCloseTo(-36, 5)
  })
})

describe('the guard of the first answer', () => {
  it('silences nothing until a tone was played and an answer starts', () => {
    const guard = new FirstSpeechGuard()
    expect(guard.silences(0)).toBe(false)
    guard.speechStarts(5, 0)
    expect(guard.silences(5.1)).toBe(false)
  })

  it('silences the start of the first answer after the tone, and only that one', () => {
    const guard = new FirstSpeechGuard()
    guard.arm()
    expect(guard.silences(3)).toBe(false)
    guard.speechStarts(10, 0)
    expect(guard.silences(9.99)).toBe(false)
    expect(guard.silences(10)).toBe(true)
    expect(guard.silences(10 + FIRST_SPEECH_GUARD_SECS - 0.01)).toBe(true)
    expect(guard.silences(10 + FIRST_SPEECH_GUARD_SECS)).toBe(false)
    // The second answer is not guarded: the user may speak into it at once.
    guard.speechStarts(20, 0)
    expect(guard.silences(20.1)).toBe(false)
  })

  it('waits longer on a device that plays late, up to a limit', () => {
    const guard = new FirstSpeechGuard()
    guard.arm()
    guard.speechStarts(1, 0.25)
    expect(guard.silences(1 + FIRST_SPEECH_GUARD_SECS + 0.2)).toBe(true)
    expect(guard.silences(1 + FIRST_SPEECH_GUARD_SECS + 0.26)).toBe(false)
    guard.arm()
    guard.speechStarts(50, 30)
    expect(guard.silences(50 + FIRST_SPEECH_GUARD_MAX_SECS - 0.01)).toBe(true)
    expect(guard.silences(50 + FIRST_SPEECH_GUARD_MAX_SECS)).toBe(false)
    guard.arm()
    guard.speechStarts(100, Number.NaN)
    expect(guard.silences(100 + FIRST_SPEECH_GUARD_SECS)).toBe(false)
  })

  it('a new microphone arms it again, a reset clears it', () => {
    const guard = new FirstSpeechGuard()
    guard.arm()
    guard.speechStarts(1, 0)
    guard.arm()
    guard.speechStarts(30, 0)
    expect(guard.silences(30.2)).toBe(true)
    guard.reset()
    expect(guard.silences(30.2)).toBe(false)
    guard.speechStarts(40, 0)
    expect(guard.silences(40.1)).toBe(false)
  })
})

describe('the microphone held before the connection', () => {
  const chunk = (value: number) => new Int16Array(512).fill(value)

  it('gives back what it holds in order, once', () => {
    const held = new HeldAudio(10)
    held.push(chunk(1)); held.push(chunk(2)); held.push(chunk(3))
    expect(held.length).toBe(3)
    expect(held.take(2).map((c) => c[0])).toEqual([1, 2])
    expect(held.length).toBe(1)
    expect(held.take(5).map((c) => c[0])).toEqual([3])
    expect(held.take(5)).toEqual([])
  })

  it('never holds more than its limit: the oldest falls out', () => {
    const held = new HeldAudio(4)
    for (let i = 1; i <= 1000; i++) held.push(chunk(i))
    expect(held.length).toBe(4)
    expect(held.take(4).map((c) => c[0])).toEqual([997, 998, 999, 1000])
  })

  it('a minute of a 16 kHz microphone stays under two megabytes', () => {
    const held = HeldAudio.forSeconds(HELD_MIC_SECS, 16_000, 512)
    for (let i = 0; i < 9000; i++) held.push(chunk(i % 100))
    const bytes = held.take(9000).reduce((sum, c) => sum + c.byteLength, 0)
    expect(bytes).toBeGreaterThanOrEqual(HELD_MIC_SECS * 16_000 * 2)
    expect(bytes).toBeLessThan(2 * 1024 * 1024)
  })

  it('is sent faster than real time, never in one burst, and always moves on', () => {
    // 20 ms of sending at 16 kHz in chunks of 512: five chunks, which are 160 ms of audio.
    expect(heldChunksDue(0.02, 16_000, 512)).toBe(5)
    expect(heldChunksDue(0, 16_000, 512)).toBe(1)
    expect(heldChunksDue(-1, 16_000, 512)).toBe(1)
    // A window whose timers were slowed to one a second still catches up.
    expect(heldChunksDue(1, 16_000, 512) * 512).toBeGreaterThan(16_000 * 2)
    // A cold start can take most of a minute. All of it is through in under eight seconds.
    expect(HELD_MIC_SECS).toBeGreaterThanOrEqual(60)
    expect(HELD_MIC_SECS / HELD_MIC_SPEED).toBeLessThan(8)
  })

  it('clear drops everything', () => {
    const held = new HeldAudio(4)
    held.push(chunk(1))
    held.clear()
    expect(held.length).toBe(0)
  })
})
