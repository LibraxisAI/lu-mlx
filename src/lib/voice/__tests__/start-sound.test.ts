import { describe, expect, it } from 'vitest'
import { renderStartSound, START_SOUND_PEAK, START_SOUND_SECS } from '../start-sound'

const peak = (samples: Float32Array) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)

describe('the start sound of a voice session', () => {
  for (const rate of [16_000, 44_100, 48_000]) {
    it(`at ${rate} Hz it is short, quiet, and starts and ends without a click`, () => {
      const sound = renderStartSound(rate)
      expect(START_SOUND_SECS).toBeLessThan(1.5)
      expect(sound.length).toBe(Math.round(START_SOUND_SECS * rate))
      // Never near full scale: the loudest sample is at -22 dBFS.
      expect(peak(sound)).toBeCloseTo(START_SOUND_PEAK, 5)
      expect(20 * Math.log10(rms(sound))).toBeLessThan(-30)
      // Silence at both ends, and a quiet first and last hundredth of a second.
      expect(sound[0]).toBe(0)
      expect(Math.abs(sound[sound.length - 1])).toBeLessThan(1e-6)
      const edge = Math.round(rate / 100)
      expect(peak(sound.subarray(0, Math.round(rate / 500)))).toBeLessThan(START_SOUND_PEAK / 20)
      expect(peak(sound.subarray(sound.length - edge))).toBeLessThan(START_SOUND_PEAK / 50)
      // No jump from one sample to the next anywhere: that would be a click.
      // The fastest thing in it is the octave of the top note, about 1.3 kHz.
      let step = 0
      for (let i = 1; i < sound.length; i += 1) step = Math.max(step, Math.abs(sound[i] - sound[i - 1]))
      expect(step).toBeLessThan(START_SOUND_PEAK * 2 * Math.PI * 1400 / rate)
      expect(sound.every((value) => Number.isFinite(value))).toBe(true)
    })
  }

  it('is the same sound every time', () => {
    expect(Array.from(renderStartSound(16_000))).toEqual(Array.from(renderStartSound(16_000)))
  })

  it('rings out: the second half is much quieter than the first', () => {
    const sound = renderStartSound(48_000)
    const half = sound.length / 2
    expect(rms(sound.subarray(half))).toBeLessThan(rms(sound.subarray(0, half)) / 2)
  })
})
