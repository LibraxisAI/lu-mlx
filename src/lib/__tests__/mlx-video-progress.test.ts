/**
 * A local video run says which step it is on and what is left.
 *
 * The lines are the ones a real Wan 2.1 1.3B run printed on 10.10.2026 (105
 * frames at 832 by 480, fifty steps at about 45 seconds each). The run was
 * stopped by hand after 28 minutes because the app only counted seconds.
 *
 * Run: npx vitest run src/lib/__tests__/mlx-video-progress.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  longVideoRunLine, timeLeftWords, videoRunGivenUp, videoRunProgress, videoRunStatus,
  VIDEO_RUN_CEILING_MS, VIDEO_RUN_HOUR_MS, VIDEO_RUN_STALL_MS,
} from '../mlx-video-progress'

const LOADING = ['Loading T5 encoder...', 'Encoding text...', 'Denoising (50 steps)...']
const FIRST = 'Diffusion:   0%|          | 0/50 [00:00<?, ?it/s]'
const STEP_36 = 'Diffusion:  72%|███████▏  | 36/50 [27:31<10:36, 45.45s/it]'
const LAST = 'Diffusion: 100%|██████████| 50/50 [37:55<00:00, 45.50s/it]'

describe('videoRunProgress', () => {
  it('reads the step and what the engine expects to still need', () => {
    expect(videoRunProgress([...LOADING, FIRST, STEP_36])).toEqual({ step: 36, of: 50, secondsLeft: 636 })
  })

  it('takes the newest step line, whatever is printed after it', () => {
    expect(videoRunProgress([FIRST, STEP_36, 'UserWarning: resource_tracker'])?.step).toBe(36)
  })

  it('has no estimate before the first step is timed', () => {
    expect(videoRunProgress([FIRST])).toEqual({ step: 0, of: 50, secondsLeft: undefined })
  })

  it('reads an estimate of more than an hour', () => {
    expect(videoRunProgress(['Diffusion:   2%|▏   | 1/50 [01:30<1:13:30, 90.00s/it]'])?.secondsLeft).toBe(4410)
  })

  it('says nothing while the run only loads', () => {
    expect(videoRunProgress(LOADING)).toBeNull()
    expect(videoRunProgress([])).toBeNull()
  })
})

describe('videoRunStatus', () => {
  it('names the step and the time left', () => {
    expect(videoRunStatus([FIRST, STEP_36], 1700)).toEqual({ percent: 71, text: 'Step 36/50, about 11 min left' })
  })

  it('does not fill the bar before a step is done', () => {
    const early = videoRunStatus(LOADING, 40)
    expect(early.text).toBe('Generating the video... 40s')
    expect(early.percent).toBeLessThanOrEqual(8)
    expect(videoRunStatus([FIRST], 60)).toEqual({ percent: 8, text: 'Step 0/50' })
  })

  it('after the last step the clip is being written', () => {
    expect(videoRunStatus([LAST], 2300)).toEqual({ percent: 95, text: 'Step 50/50, writing the clip' })
  })

  it('rounds the time left to minutes', () => {
    expect(timeLeftWords(45)).toBe('under a minute left')
    expect(timeLeftWords(636)).toBe('about 11 min left')
  })
})

describe('videoRunGivenUp', () => {
  const MIN = 60_000

  it('a run that keeps making steps is not cut off at the hour', () => {
    expect(videoRunGivenUp({ elapsedMs: 75 * MIN, step: 41, sinceStepChangeMs: 40_000 })).toBeNull()
  })

  it('a run whose steps stopped is given up', () => {
    expect(videoRunGivenUp({ elapsedMs: 30 * MIN, step: 12, sinceStepChangeMs: VIDEO_RUN_STALL_MS + 1 }))
      .toBe('Generation stopped: no new step for 20 minutes')
  })

  it('a run that prints no steps keeps the hour it always had', () => {
    expect(videoRunGivenUp({ elapsedMs: VIDEO_RUN_HOUR_MS - 1, step: null, sinceStepChangeMs: VIDEO_RUN_HOUR_MS - 1 })).toBeNull()
    expect(videoRunGivenUp({ elapsedMs: VIDEO_RUN_HOUR_MS + 1, step: null, sinceStepChangeMs: VIDEO_RUN_HOUR_MS + 1 }))
      .toBe('Generation timed out after 60 minutes')
  })

  it('nothing runs past the ceiling', () => {
    expect(videoRunGivenUp({ elapsedMs: VIDEO_RUN_CEILING_MS + 1, step: 3, sinceStepChangeMs: 1000 })).toBe('Generation stopped after 4 hours')
  })
})

describe('longVideoRunLine', () => {
  // 345 seconds of run per second of clip: Wan 2.1 T2V 1.3B on an M5 Pro.
  it('says the time before a long run, and whose Mac it was timed on', () => {
    expect(longVideoRunLine('Wan 2.1 T2V 1.3B', 6.5625, 345)).toBe(
      'A clip of 6.6 seconds with Wan 2.1 T2V 1.3B takes about 38 minutes on an M5 Pro with 48 GB, and longer on a smaller Mac. '
      + 'The run shows its step and the time left, and a shorter clip is done sooner.',
    )
  })

  it('says nothing for a short run', () => {
    // LTX-2.3 4-bit: two seconds of clip in about a minute.
    expect(longVideoRunLine('LTX-2.3 Distilled 4-bit', 2, 32)).toBeNull()
  })

  it('says nothing for a model nobody has timed', () => {
    expect(longVideoRunLine('Wan 2.2 TI2V 5B 8-bit', 5, undefined)).toBeNull()
    expect(longVideoRunLine('Wan 2.2 TI2V 5B 8-bit', 5, 0)).toBeNull()
  })
})

describe('the run in Create uses it', () => {
  it('the bar no longer follows the clock', () => {
    const hook = readFileSync(resolve(__dirname, '../../hooks/useCreate.ts'), 'utf8')
    expect(hook).toContain('videoRunStatus(prog.logs, elapsed)')
    expect(hook).not.toContain('Math.min(95, elapsed * 2)')
    expect(hook).toContain('videoRunGivenUp(')
  })
})
