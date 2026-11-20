// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { useChatStore } from '../../../stores/chatStore'
import { prepareChatImages } from '../../../lib/chat-image-input'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'

vi.mock('../../../lib/chat-image-input', () => ({ MAX_CHAT_IMAGES: 5, prepareChatImages: vi.fn() }))
const prepare = vi.mocked(prepareChatImages)
const picture = { data: 'cGljdHVyZQ==', mimeType: 'image/png', name: 'test.png' }
let finish: (value: { images: typeof picture[]; errors: string[] }) => void
beforeEach(() => {
  prepare.mockReset()
  prepare.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useChatStore.setState({ activeConversationId: 'a' })
  useChatNoticeStore.getState().clear()
})
afterEach(cleanup)
function setup() {
  const send = vi.fn()
  const { container } = render(<ChatInput onSend={send} onStop={() => {}} isGenerating={false} modelReady={() => true} />)
  const input = container.querySelector('input[type=file]')!
  const attach = () => fireEvent.change(input, { target: { files: [new File(['data'], 'test.png', { type: 'image/png' })] } })
  return { send, attach }
}

describe('attachment completion belongs to its composer', () => {
  it('blocks Enter and duplicate uploads until images are ready, then sends exactly once', async () => {
    const { send, attach } = setup()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'describe this' } })
    attach(); attach()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(1)
    await act(async () => finish({ images: [picture], errors: [] }))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).toHaveBeenCalledWith('describe this', [picture])
    expect(screen.queryByAltText('test.png')).toBeNull()
  })
  it('does not attach a late image to a different chat', async () => {
    const { attach } = setup()
    attach()
    act(() => useChatStore.setState({ activeConversationId: 'b' }))
    expect(prepare.mock.calls[0][2]!()).toBe(true)
    await act(async () => finish({ images: [picture], errors: [] }))
    expect(screen.queryByAltText('test.png')).toBeNull()
  })
  it('also cancels a late image when switching away and back during its decode', async () => {
    const { attach } = setup()
    attach()
    act(() => useChatStore.setState({ activeConversationId: 'b' }))
    act(() => useChatStore.setState({ activeConversationId: 'a' }))
    expect(prepare.mock.calls[0][2]!()).toBe(true)
    await act(async () => finish({ images: [picture], errors: [] }))
    expect(screen.queryByAltText('test.png')).toBeNull()
  })
  it('keeps a readable error and accepts another selection after a rejected image', async () => {
    const { attach } = setup()
    attach()
    await act(async () => finish({ images: [], errors: ['test.png: This image exceeds 20 MB.'] }))
    // Said at the head of the transcript (ChatNotices), never in the composer.
    const notices = () => useChatNoticeStore.getState().notices.map(n => n.text)
    expect(notices()).toEqual(['test.png: This image exceeds 20 MB.'])
    expect(screen.queryByText('test.png: This image exceeds 20 MB.')).toBeNull()
    attach()
    expect(prepare).toHaveBeenCalledTimes(2)
    await act(async () => finish({ images: [picture], errors: [] }))
    expect(screen.getByAltText('test.png')).toBeTruthy()
  })
  it('a second selection while images are preparing is refused out loud, not silently', async () => {
    const { attach } = setup()
    attach()
    expect(useChatNoticeStore.getState().notices.map(n => n.text)).toEqual(['Preparing images…'])
    attach()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(useChatNoticeStore.getState().notices.map(n => n.text)).toEqual(['Still preparing the previous images. Add these again in a moment.'])
    await act(async () => finish({ images: [picture], errors: [] }))
    expect(screen.getByAltText('test.png')).toBeTruthy()
  })
  it('the preparing line goes away when the images are ready', async () => {
    const { attach } = setup()
    attach()
    await act(async () => finish({ images: [picture], errors: [] }))
    expect(useChatNoticeStore.getState().notices).toEqual([])
  })
})
