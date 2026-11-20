// Sample rate conversion for the voice session's audio.
//
// The webview runs ONE AudioContext at the rate of the sound device (48 kHz on
// most machines, 44.1 kHz on some). The voice loop wants 16 kHz microphone
// audio and sends 24 kHz speech. Both conversions happen here, on a stream:
// a block may end in the middle of an output sample, so every converter keeps
// what it needs to continue seamlessly with the next block.

/**
 * Converts a mono stream from one rate to another, block by block.
 *
 * Going down, every output sample is the average of the input it covers. That
 * average is the low pass that keeps frequencies above the new limit from
 * folding back into the speech band. Going up, samples are interpolated
 * linearly, which is transparent for speech at the ratios used here.
 */
export class StreamResampler {
  private readonly ratio: number
  // Going down: the part of the current output sample that is already filled.
  private acc = 0
  private filled = 0
  // Going up: the last input sample and the position between it and the next.
  private last = 0
  private position = 0

  constructor(from: number, to: number) {
    if (!(from > 0) || !(to > 0)) throw new Error('Sample rates must be positive.')
    this.ratio = from / to
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input
    return this.ratio > 1 ? this.down(input) : this.up(input)
  }

  /** Forget the carried state, for example after playback was interrupted. */
  reset(): void {
    this.acc = 0
    this.filled = 0
    this.last = 0
    this.position = 0
  }

  private down(input: Float32Array): Float32Array {
    const ratio = this.ratio
    const out = new Float32Array(Math.ceil((this.filled + input.length) / ratio) + 1)
    let n = 0
    let acc = this.acc
    let filled = this.filled
    for (let i = 0; i < input.length; i++) {
      const x = input[i]
      let weight = 1
      while (weight > 1e-9) {
        const need = ratio - filled
        if (weight < need) {
          acc += x * weight
          filled += weight
          weight = 0
        } else {
          acc += x * need
          out[n++] = acc / ratio
          acc = 0
          filled = 0
          weight -= need
        }
      }
    }
    this.acc = acc
    this.filled = filled
    return out.subarray(0, n)
  }

  private up(input: Float32Array): Float32Array {
    const step = this.ratio
    const count = input.length
    const out = new Float32Array(Math.ceil((count - this.position) / step) + 1)
    let n = 0
    let t = this.position
    while (t < count) {
      const i = Math.floor(t)
      const a = i === 0 ? this.last : input[i - 1]
      out[n++] = a + (input[i] - a) * (t - i)
      t += step
    }
    if (count > 0) this.last = input[count - 1]
    this.position = t - count
    return out.subarray(0, n)
  }
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const x = Math.max(-1, Math.min(1, input[i]))
    out[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff)
  }
  return out
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000
  return out
}

/**
 * Cuts a stream of samples into chunks of one fixed size. The voice loop's
 * speech detector works on frames, and evenly sized messages keep its timing
 * steady whatever block size the audio device delivers.
 */
export class Int16Chunker {
  private readonly size: number
  private pending: Int16Array
  private used = 0

  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0) throw new Error('Chunk size must be a positive integer.')
    this.size = size
    this.pending = new Int16Array(size)
  }

  push(input: Int16Array): Int16Array[] {
    const chunks: Int16Array[] = []
    let offset = 0
    while (offset < input.length) {
      const take = Math.min(this.size - this.used, input.length - offset)
      this.pending.set(input.subarray(offset, offset + take), this.used)
      this.used += take
      offset += take
      if (this.used === this.size) {
        chunks.push(this.pending)
        this.pending = new Int16Array(this.size)
        this.used = 0
      }
    }
    return chunks
  }

  reset(): void {
    this.used = 0
  }
}

/** Loudness of a block, 0 to 1, for the level display. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0
  let sum = 0
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
  return Math.sqrt(sum / input.length)
}
