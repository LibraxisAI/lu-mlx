import { describe, expect, it } from 'vitest'
import { Int16Chunker, StreamResampler, floatToInt16, int16ToFloat, rms } from '../resample'

function sine(rate: number, hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Push `input` through a fresh resampler in blocks of the given sizes. */
function run(from: number, to: number, input: Float32Array, blocks: number[]): Float32Array {
  const resampler = new StreamResampler(from, to)
  const parts: Float32Array[] = []
  let at = 0
  for (let i = 0; at < input.length; i++) {
    const size = blocks[i % blocks.length]
    parts.push(Float32Array.from(resampler.push(input.subarray(at, at + size))))
    at += size
  }
  return concat(parts)
}

describe('StreamResampler', () => {
  for (const [from, to] of [[48_000, 16_000], [44_100, 16_000], [24_000, 48_000], [24_000, 44_100]] as const) {
    it(`keeps the length of one second from ${from} to ${to}`, () => {
      const out = run(from, to, sine(from, 440, 1), [960])
      expect(Math.abs(out.length - to)).toBeLessThanOrEqual(1)
    })

    it(`gives the same samples from ${from} to ${to} whatever the block size`, () => {
      const input = sine(from, 300, 0.5)
      const whole = run(from, to, input, [input.length])
      const pieces = run(from, to, input, [128, 441, 1000, 7])
      expect(pieces.length).toBe(whole.length)
      for (let i = 0; i < whole.length; i++) expect(pieces[i]).toBeCloseTo(whole[i], 5)
    })

    it(`keeps a 300 Hz tone a 300 Hz tone from ${from} to ${to}`, () => {
      const out = run(from, to, sine(from, 300, 1), [960])
      // Count upward zero crossings: one per period.
      let crossings = 0
      for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++
      expect(Math.abs(crossings - 300)).toBeLessThanOrEqual(2)
      expect(rms(out)).toBeGreaterThan(0.6)
      expect(rms(out)).toBeLessThan(0.75)
    })
  }

  it('removes a tone above the new limit instead of folding it into the speech band', () => {
    // 15 kHz cannot exist at 16 kHz. Without the averaging it would come out
    // as a loud 1 kHz tone.
    const out = run(48_000, 16_000, sine(48_000, 15_000, 0.5), [960])
    expect(rms(out)).toBeLessThan(0.25)
  })

  it('returns the block itself when the rates are equal', () => {
    const block = sine(16_000, 200, 0.01)
    expect(new StreamResampler(16_000, 16_000).push(block)).toBe(block)
  })

  it('starts clean after a reset', () => {
    const resampler = new StreamResampler(24_000, 48_000)
    resampler.push(Float32Array.from([1, 1, 1]))
    resampler.reset()
    const out = resampler.push(Float32Array.from([0, 0, 0, 0]))
    expect(Array.from(out).every((x) => x === 0)).toBe(true)
  })

  it('refuses rates that cannot be rates', () => {
    expect(() => new StreamResampler(0, 16_000)).toThrow()
    expect(() => new StreamResampler(48_000, Number.NaN)).toThrow()
  })
})

describe('PCM conversion', () => {
  it('clips instead of wrapping around', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384])
  })

  it('survives a round trip within one step', () => {
    const pcm = Int16Array.from([0, 1, -1, 12345, -12345, 32767, -32768])
    const back = floatToInt16(int16ToFloat(pcm))
    for (let i = 0; i < pcm.length; i++) expect(Math.abs(back[i] - pcm[i])).toBeLessThanOrEqual(1)
  })
})

describe('Int16Chunker', () => {
  it('emits only full chunks and loses no sample', () => {
    const chunker = new Int16Chunker(512)
    const seen: number[] = []
    let next = 0
    for (const size of [100, 700, 512, 3, 1021, 0, 224]) {
      const block = Int16Array.from({ length: size }, () => next++)
      for (const chunk of chunker.push(block)) {
        expect(chunk.length).toBe(512)
        expect(chunk.buffer.byteLength).toBe(1024)
        seen.push(...chunk)
      }
    }
    expect(seen.length).toBe(Math.floor(next / 512) * 512)
    expect(seen.every((value, index) => value === index)).toBe(true)
  })

  it('hands out a chunk that later input does not overwrite', () => {
    const chunker = new Int16Chunker(2)
    const [first] = chunker.push(Int16Array.from([1, 2]))
    chunker.push(Int16Array.from([3, 4]))
    expect(Array.from(first)).toEqual([1, 2])
  })

  it('drops a partial chunk on reset', () => {
    const chunker = new Int16Chunker(4)
    chunker.push(Int16Array.from([9, 9, 9]))
    chunker.reset()
    expect(Array.from(chunker.push(Int16Array.from([1, 2, 3, 4]))[0])).toEqual([1, 2, 3, 4])
  })
})
