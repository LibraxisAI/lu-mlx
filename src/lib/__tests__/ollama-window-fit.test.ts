/**
 * What is said about a model that does not sit in graphics memory entirely.
 * Only measured numbers are turned into words (lib/ollama-window-fit.ts).
 */
import { describe, it, expect } from 'vitest'
import { cpuSharePercent, loadedOnCpuLabel, loadedOnCpuSentence, loadedOnCpuTitle } from '../ollama-window-fit'

const GB = 1_073_741_824

describe('the share of a loaded model on the CPU', () => {
  it('is the part of `size` that is not in `size_vram`', () => {
    // `ollama ps` of the measurement in lib/context-window.ts: 34%/66% CPU/GPU.
    expect(cpuSharePercent({ size: 15 * GB, sizeVram: 9.9 * GB })).toBe(34)
    expect(cpuSharePercent({ size: 12 * GB, sizeVram: 12 * GB })).toBe(0)
    expect(cpuSharePercent({ size: 12 * GB, sizeVram: 0 })).toBe(100)
  })

  it('is unknown when Ollama reported no size', () => {
    expect(cpuSharePercent({ size: 0, sizeVram: 0 })).toBeNull()
    expect(cpuSharePercent({ size: Number.NaN, sizeVram: 1 })).toBeNull()
  })

  it('never rounds a part away: a sliver on the CPU is not "none", a sliver on the card is not "all"', () => {
    expect(cpuSharePercent({ size: 1000 * GB, sizeVram: 999 * GB })).toBe(1)
    expect(cpuSharePercent({ size: 1000 * GB, sizeVram: 1 * GB })).toBe(99)
  })

  it('a card that reports more than the model takes is a model that is entirely on it', () => {
    expect(cpuSharePercent({ size: 8 * GB, sizeVram: 9 * GB })).toBe(0)
  })
})

describe('the sentences', () => {
  it('say nothing for a model that is entirely in graphics memory, and nothing without numbers', () => {
    for (const loaded of [{ size: 12 * GB, sizeVram: 12 * GB }, { size: 0, sizeVram: 0 }, null, undefined]) {
      expect(loadedOnCpuSentence(loaded)).toBeNull()
      expect(loadedOnCpuLabel(loaded)).toBeNull()
      expect(loadedOnCpuTitle(loaded)).toBeNull()
    }
  })

  it('name the measured size and share where the window is set', () => {
    expect(loadedOnCpuSentence({ size: 15 * GB, sizeVram: 9.9 * GB })).toBe(
      'Loaded now with this window: 15 GB, 34% of it on the CPU, so answers are slower. A smaller context window needs less memory.',
    )
  })

  it('do not blame the window for a machine that has no card at all', () => {
    expect(loadedOnCpuSentence({ size: 5.2 * GB, sizeVram: 0 })).toBe('Loaded now with this window: 5.2 GB, all of it on the CPU.')
  })

  it('are short on a row of the model picker, with the numbers in the tooltip', () => {
    expect(loadedOnCpuLabel({ size: 15 * GB, sizeVram: 9.9 * GB })).toBe('34% on the CPU')
    expect(loadedOnCpuLabel({ size: 5 * GB, sizeVram: 0 })).toBe('on the CPU')
    expect(loadedOnCpuTitle({ size: 15 * GB, sizeVram: 9.9 * GB })).toBe(
      'Ollama reports 15 GB for this model as it is loaded now, and 9.9 GB of that in graphics memory. The rest runs on the CPU, which is slower. A smaller context window needs less memory.',
    )
  })

  it('carry no dash of the long kind and no token count for money', () => {
    const all = [loadedOnCpuSentence({ size: 15 * GB, sizeVram: 9 * GB }), loadedOnCpuTitle({ size: 15 * GB, sizeVram: 9 * GB })].join(' ')
    expect(all).not.toMatch(/[\u2013\u2014]/)
  })
})
