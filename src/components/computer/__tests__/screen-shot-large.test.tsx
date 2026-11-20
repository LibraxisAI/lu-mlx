// @vitest-environment jsdom
/**
 * The picture of a look, opened large.
 *
 * Windows run A22: the large picture was cut off on the left and lay under
 * the sidebar. A message of the chat is its own box for layout and paint, so
 * a popup that stays inside it cannot cover the window.
 *
 * Run: npx vitest run src/components/computer/__tests__/screen-shot-large.test.tsx
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ScreenShotStrip } from '../ScreenShotStrip'
import { captionScreenShot, clearScreenShots, keepScreenShot, setScreenShotUrlsForTests } from '../../../lib/computer/screen-shots'

afterEach(() => {
  cleanup()
  clearScreenShots()
  setScreenShotUrlsForTests(null)
})

describe('a screenshot opened large', () => {
  it('opens over the whole window, outside the message it belongs to', () => {
    setScreenShotUrlsForTests({ make: () => 'blob:shot', release: () => undefined })
    keepScreenShot('call-1', 7, { data: 'QUJD', mimeType: 'image/jpeg' })
    captionScreenShot(7, 'Step 1: Click at 203, 235')
    const { container } = render(<div data-testid="message"><ScreenShotStrip callId="call-1" /></div>)
    fireEvent.click(screen.getByRole('button', { name: 'Open screenshot: Step 1: Click at 203, 235' }))
    const dialog = screen.getByRole('dialog', { name: 'Step 1: Click at 203, 235' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:shot')
    // Not inside the message, and so not inside the chat column.
    expect(container.contains(dialog)).toBe(false)
    expect(dialog.closest('[data-lu-dialog]')?.parentElement).toBe(document.body)
  })
})
