/**
 * @vitest-environment jsdom
 *
 * Recommended memory and the least a run is let through with are two numbers.
 *
 * Real run on an M5 Pro with 48 GB, 09.10.2026: Wan 2.1 T2V 1.3B, promised
 * for 16 GB, peaked at 24.5 GB, and its text encoder alone stood at 25.6 GB.
 * Nobody has run it on a Mac with 16 or 24 GB. So its tile and the "Fits my
 * Mac" filter go by 32 GB, the download stays a click ("Get anyway"), a run
 * is not refused, and Create says before the run what is known.
 *
 * Run: npx vitest run src/lib/__tests__/mac-memory-fit.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { fitsMacMemory, memoryNeedGb } from '../mac-memory-fit'
import { MacMediaTile } from '../../components/models/MacMediaTile'
import { macVideoMemoryLine } from '../../components/create/experimental/MacVideoMemoryNotice'
import { buildMlxVideoModels, type VideoModel } from '../../api/mlx-video'

afterEach(cleanup)

const wan = {
  id: 'wan21-t2v-1.3b', name: 'Wan 2.1 T2V 1.3B', repo: 'Wan-AI/Wan2.1-T2V-1.3B', sizeBytes: 18e9,
  minRamGB: 16, recommendedRamGB: 32, unfiltered: false,
  description: 'Slow on a Mac: about half an hour for five seconds on an M5 Pro, and without sound. 480p text to video, with a one-time convert step after the download.',
}
const noop = () => {}
const tile = (model: typeof wan | Omit<typeof wan, 'recommendedRamGB'>, memoryGb: number | null) =>
  render(<MacMediaTile model={model} memoryGb={memoryGb} state={{ kind: 'idle' }} onGet={noop} onCancel={noop} onRemove={noop} onOpenUrl={noop} />)

describe('the memory a model is held against', () => {
  it('is the recommended one where the catalogue names it, the least one otherwise', () => {
    expect(memoryNeedGb({ minRamGB: 16, recommendedRamGB: 32 })).toBe(32)
    expect(memoryNeedGb({ minRamGB: 16 })).toBe(16)
  })

  it('a Mac sold as 16 GB is 16, and an unknown number is no verdict', () => {
    expect(fitsMacMemory(16, 15.6)).toBe(true)
    expect(fitsMacMemory(32, 24)).toBe(false)
    expect(fitsMacMemory(32, 32)).toBe(true)
    expect(fitsMacMemory(32, null)).toBeNull()
    expect(fitsMacMemory(0, 32)).toBeNull()
  })
})

describe('the tile of Wan 2.1 T2V 1.3B', () => {
  it('fits from 32 GB on', () => {
    const { container } = tile(wan, 32)
    expect(container.querySelector('[data-memory-fit]')?.getAttribute('data-memory-fit')).toBe('fits')
    expect(screen.getByText('Runs on this Mac')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Get$/ })).toBeTruthy()
    expect(screen.getByText('needs 32 GB memory')).toBeTruthy()
  })

  it('on 16 and 24 GB it says 32 GB and keeps its download as "Get anyway"', () => {
    for (const memoryGb of [16, 24]) {
      const { container } = tile(wan, memoryGb)
      expect(container.querySelector('[data-memory-fit]')?.getAttribute('data-memory-fit')).toBe('big')
      expect(screen.getByText('Needs a Mac with 32 GB memory')).toBeTruthy()
      const get = screen.getByRole('button', { name: /Get anyway/ }) as HTMLButtonElement
      expect(get.disabled).toBe(false)
      cleanup()
    }
  })

  it('begins with what was measured, so the two lines a tile shows carry it', () => {
    tile(wan, 48)
    expect(screen.getByText(/^Slow on a Mac: about half an hour for five seconds on an M5 Pro, and without sound\./)).toBeTruthy()
  })

  it('COUNTER-CHECK: a model with one number is held against that one, as before', () => {
    const { recommendedRamGB: _none, ...image } = wan
    const { container } = tile(image, 16)
    expect(container.querySelector('[data-memory-fit]')?.getAttribute('data-memory-fit')).toBe('fits')
    expect(screen.getByText('needs 16 GB memory')).toBeTruthy()
  })
})

describe('the line Create shows before a run', () => {
  it('speaks on a Mac below the recommended memory, and only there', () => {
    expect(macVideoMemoryLine('MLX Wan 2.1 T2V 1.3B', 32, 16)).toBe(
      'Wan 2.1 T2V 1.3B is recommended for Macs with 32 GB of memory, and this one has 16 GB. '
      + 'It has not been measured on a Mac this size: a run can be very slow or stop for lack of memory. Close other apps before you start.',
    )
    expect(macVideoMemoryLine('MLX Wan 2.1 T2V 1.3B', 32, 24)).toContain('this one has 24 GB')
    expect(macVideoMemoryLine('MLX Wan 2.1 T2V 1.3B', 32, 32)).toBeNull()
    expect(macVideoMemoryLine('MLX Wan 2.1 T2V 1.3B', 32, 48)).toBeNull()
    expect(macVideoMemoryLine('MLX LTX-2.3 Distilled 4-bit', 16, 16)).toBeNull()
    // Memory nobody could read, or an entry that names none: no line.
    expect(macVideoMemoryLine('MLX Wan 2.1 T2V 1.3B', 32, null)).toBeNull()
    expect(macVideoMemoryLine('MLX Wan 2.1 T2V 1.3B', undefined, 16)).toBeNull()
  })

  it('reads the number from the catalogue entry of the installed model', () => {
    const entry = (more: Partial<VideoModel>): VideoModel => ({
      id: 'x', name: 'X', family: 'wan_2', repo: 'a/b', sizeGB: 18, sizeBytes: 18e9, minRamGB: 16, defaultFrames: 81,
      fps: 16, defaultWidth: 832, defaultHeight: 480, negativePrompt: true, userSampling: false, needsConvert: true,
      unfiltered: false, description: '', installed: true, ...more,
    })
    const [withBoth, withOne] = buildMlxVideoModels([entry({ id: 'a', name: 'A', recommendedRamGB: 32 }), entry({ id: 'b', name: 'B' })])
    expect(withBoth.mlxVideo?.recommendedRamGB).toBe(32)
    expect(withOne.mlxVideo?.recommendedRamGB).toBe(16)
  })
})
