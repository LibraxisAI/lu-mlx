// @vitest-environment jsdom
/**
 * 10.10.2026: an image made in the chat shows its prompt in the big
 * view, with a button that copies it. The card is the web's; the desktop
 * draws its big view over the whole app (OverTheApp.tsx).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../save-media', () => ({ saveChatMedia: vi.fn() }))

import { CreateMedia } from '../CreateMedia'
import { orderMedia } from '../CreateOrders'
import type { CreateMediaView } from '../types'
import type { Order } from '../../../../lib/create/order'

afterEach(() => { cleanup() })

const MEDIA: CreateMediaView = { kind: 'image', url: 'https://example.com/a.png', title: 'Neon city', model: 'Some model', prompt: 'a neon city in the rain' }

function open(media: CreateMediaView = MEDIA) {
  const view = render(<div data-testid="thread"><CreateMedia media={media} /></div>)
  fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
  return view
}

describe('the big view of a chat image', () => {
  it('opens from the card and shows the prompt of the run, unfolded', () => {
    open()
    const big = screen.getByRole('dialog', { name: 'Image preview' })
    expect(big.querySelector('[data-testid=prompt-text]')?.textContent).toBe('a neon city in the rain')
    expect((big.querySelector('[data-testid=prompt-details]') as HTMLDetailsElement).open).toBe(true)
  })

  it('is drawn over the app, not inside the thread', () => {
    open()
    const big = screen.getByRole('dialog')
    expect(screen.getByTestId('thread').contains(big)).toBe(false)
    expect(big.parentElement).toBe(document.body)
  })

  it('copies the prompt, and a click in the box does not close the view', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    fireEvent.click(screen.getByTestId('prompt-text'))
    expect(writeText).toHaveBeenCalledWith('a neon city in the rain')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('still closes on the picture, the button and Escape, and leaves nothing behind', () => {
    for (const close of [
      () => fireEvent.click(screen.getByRole('dialog').querySelector('img') as HTMLElement),
      () => fireEvent.click(screen.getByRole('button', { name: 'Close' })),
      () => fireEvent.keyDown(window, { key: 'Escape' }),
    ]) {
      open()
      close()
      expect(screen.queryByRole('dialog')).toBeNull()
      cleanup()
    }
  })

  it('a result without a prompt shows the picture and no box', () => {
    for (const prompt of [undefined, '', '  ']) {
      open({ ...MEDIA, prompt })
      expect(screen.getByRole('dialog').querySelector('img')).toBeTruthy()
      expect(screen.queryByTestId('prompt-details')).toBeNull()
      cleanup()
    }
  })
})

describe('orderMedia', () => {
  const run = (extra: Record<string, unknown>) => ({
    title: 'Image', kind: 'image', model: 'm', prompt: 'a neon city in the rain', options: {}, status: 'done', jobId: 'j1', resultUrl: 'https://example.com/a.png', ...extra,
  })
  const order = (runs: unknown[]) => ({ id: 'o1', state: 'done', items: [{ n: 1, title: 'Neon city', runs }] }) as unknown as Order

  it('hands each result the prompt its run had', () => {
    expect(orderMedia(order([run({})]))[0].prompt).toBe('a neon city in the rain')
  })

  it('leaves the prompt out for a run that had none', () => {
    expect('prompt' in orderMedia(order([run({ prompt: '' })]))[0]).toBe(false)
  })
})
