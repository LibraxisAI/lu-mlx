// @vitest-environment jsdom
/**
 * C1 (Desktop Create parity, web reference:
 * the web app +
 * createStore.animateFrom in lu-300-web): a finished image's result view had
 * no "Animate this image" affordance on Desktop: Edit-with-mask, Download
 * and Fullscreen were the only hover actions. Desktop's own createStore
 * already carries a correct `case 'animate':` in setIntent() (keeps
 * `source`, no ...dropAll) and a working setSource(), so the missing piece
 * was purely the button + its onClick wiring through ResultView.
 *
 * This test is scoped to ResultView itself (OutputView.tsx), the component
 * that actually renders the hover toolbar: it is the smallest unit where
 * "the button exists, is gated like Edit, and calls back" is observable
 * without standing up the whole CreateExperimental store wiring.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/animate-button-on-result.test.tsx
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ResultView } from '../OutputView'
import type { GalleryItem } from '../../../../stores/createStore'

beforeEach(() => {
  cleanup()
})

function makeItem(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: 'g1',
    type: 'image',
    filename: 'lu_00001_.png',
    subfolder: '',
    prompt: 'a lighthouse at dusk',
    negativePrompt: '',
    model: 'sdxl.safetensors',
    modelType: 'sdxl',
    seed: 42,
    steps: 20,
    cfgScale: 5,
    sampler: 'euler',
    scheduler: 'normal',
    width: 1024,
    height: 1024,
    batchSize: 1,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('ResultView "Animate this image" action', () => {
  it('renders and fires onAnimate when the caller supplies it for a finished image', () => {
    const onAnimate = vi.fn()
    render(<ResultView item={makeItem()} onFullscreen={() => {}} onAnimate={onAnimate} />)
    const btn = screen.getByTitle('Animate this image')
    fireEvent.click(btn)
    expect(onAnimate).toHaveBeenCalledTimes(1)
  })

  it('is absent when the caller omits onAnimate (Animate lane unavailable: MLX Mac / locked intent)', () => {
    render(<ResultView item={makeItem()} onFullscreen={() => {}} />)
    expect(screen.queryByTitle('Animate this image')).toBeNull()
  })

  it('is absent on a video result even when onAnimate is supplied (nothing to animate FROM a video)', () => {
    const onAnimate = vi.fn()
    render(<ResultView item={makeItem({ type: 'video' })} onFullscreen={() => {}} onAnimate={onAnimate} />)
    expect(screen.queryByTitle('Animate this image')).toBeNull()
  })

  it('is absent while the render is unavailable (local engine unreachable), matching Edit-with-mask\'s own gate', () => {
    const onAnimate = vi.fn()
    render(<ResultView item={makeItem({ unavailable: true })} onFullscreen={() => {}} onAnimate={onAnimate} />)
    expect(screen.queryByTitle('Animate this image')).toBeNull()
  })
})
