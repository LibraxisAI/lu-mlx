// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ChatAttachment } from '../ChatAttachment'
import { previewAttachment } from '../../../lib/chat-attachments'

vi.mock('../../../lib/chat-attachments', () => ({
  previewAttachment: vi.fn(), originalAttachment: vi.fn(), attachmentBlob: () => new Blob(['image']),
  referenceId: (data: string) => data.startsWith('lu-attachment:v1:') ? data.slice(17) : null,
}))
let observe: (entries: { isIntersecting: boolean }[]) => void
const image = { data:'lu-attachment:v1:test', mimeType:'image/png', name:'test.png' }
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof observe) { observe = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  vi.mocked(previewAttachment).mockReset().mockResolvedValue({ ...image, data:'YWJj' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('loads only visible images and releases their URLs when scrolled away', async () => {
  render(<ChatAttachment image={image} />)
  expect(previewAttachment).not.toHaveBeenCalled()
  await act(async () => observe([{isIntersecting:true}]))
  expect(screen.getByAltText('test.png').getAttribute('src')).toBe('blob:test')
  await act(async () => observe([{isIntersecting:false}]))
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  expect(screen.queryByAltText('test.png')).toBeNull()
})
it('cancels stale preview work and does not allocate a URL after unmount', async () => {
  let finish!: (value: typeof image) => void
  vi.mocked(previewAttachment).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ChatAttachment image={image} />)
  await act(async () => observe([{isIntersecting:true}]))
  const cancelled = vi.mocked(previewAttachment).mock.calls[0][1]!
  expect(cancelled()).toBe(false)
  view.unmount()
  expect(cancelled()).toBe(true)
  await act(async () => finish(image))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})
it('shows an actionable error for a missing image instead of crashing the chat', async () => {
  vi.mocked(previewAttachment).mockRejectedValue(new Error('missing'))
  render(<ChatAttachment image={image} />)
  await act(async () => observe([{isIntersecting:true}]))
  expect(screen.getByRole('status').textContent).toContain('save the original')
})
