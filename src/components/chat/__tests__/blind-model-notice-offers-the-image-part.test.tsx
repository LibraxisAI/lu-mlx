/**
 * @vitest-environment jsdom
 *
 * A picture attached to a model that cannot see it. When the reason is a
 * missing image part the app knows a source for, the line at the top of the
 * transcript offers the one click. It is never drawn at the composer.
 *
 * Run: npx vitest run src/components/chat/__tests__/blind-model-notice-offers-the-image-part.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const addImagePart = vi.fn(async (_path: string, _label?: string) => {})
vi.mock('../../../api/image-part-install', async () => {
  const actual = await vi.importActual<typeof import('../../../api/image-part-install')>('../../../api/image-part-install')
  return { ...actual, addImagePart: (p: string, l?: string) => addImagePart(p, l) }
})

import { ChatNotices } from '../ChatNotices'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'
import { useModelStore } from '../../../stores/modelStore'
import { useDownloadStore } from '../../../stores/downloadStore'
import { IMAGE_INPUT_LOADED_WITHOUT, IMAGE_INPUT_MISSING } from '../../../lib/image-part'

const COMPOSER_TEXT = "This model can't read images. Switch to a vision model (Gemma 4, LLaVA, Qwen-VL) to use the attachment."
const NAME = 'openai::Qwen3.5-9B-abliterated.Q4_K_M'
const PATH = 'C:\\models\\Qwen3.5-9B-abliterated.Q4_K_M.gguf'

function activeModel(extra: Record<string, unknown>) {
  useModelStore.setState({
    activeModel: NAME,
    models: [{ name: NAME, model: 'Qwen3.5-9B-abliterated.Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine', ...extra }],
  } as never)
}

beforeEach(() => {
  addImagePart.mockClear()
  useDownloadStore.setState({ downloads: {}, downloadMeta: {} } as never)
  useChatNoticeStore.getState().clear()
  useChatNoticeStore.getState().show('model-cannot-see-images', COMPOSER_TEXT)
})
afterEach(cleanup)

describe('the line under a picture the model cannot see', () => {
  it('offers the image part with its size, and one click fetches it', async () => {
    activeModel({ path: PATH, supportsVision: false, imagePartInstalled: false })
    render(<ChatNotices />)
    expect(screen.getByTestId('chat-notices').textContent).toContain(IMAGE_INPUT_MISSING)
    const button = screen.getByTestId('add-image-input')
    expect(button.textContent).toBe('Add image input (0.9 GB)')
    await act(async () => { fireEvent.click(button) })
    expect(addImagePart).toHaveBeenCalledWith(PATH, 'Qwen3.5-9B-abliterated.Q4_K_M image input')
  })

  it('shows the progress in the place of the button while the part is on its way', () => {
    activeModel({ path: PATH, supportsVision: false, imagePartInstalled: false })
    useDownloadStore.setState({
      downloads: { 'Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf': { filename: 'x', progress: 50, total: 200, speed: 1, status: 'downloading' } },
    } as never)
    render(<ChatNotices />)
    expect(screen.queryByTestId('add-image-input')).toBeNull()
    expect(screen.getByTestId('add-image-input-progress').textContent).toContain('25%')
  })

  it('says that the model was loaded without its part when the part is installed', () => {
    activeModel({ path: PATH, supportsVision: false, imagePartInstalled: true })
    render(<ChatNotices />)
    expect(screen.getByTestId('chat-notices').textContent).toContain(IMAGE_INPUT_LOADED_WITHOUT)
    expect(screen.queryByTestId('add-image-input')).toBeNull()
  })

  it('keeps the plain sentence for a model without image input', () => {
    useModelStore.setState({
      activeModel: 'openai::glm-4-9b-chat-abliterated-Q4_K_M',
      models: [{ name: 'openai::glm-4-9b-chat-abliterated-Q4_K_M', model: 'glm-4-9b-chat-abliterated-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine', path: '/m/glm-4-9b-chat-abliterated-Q4_K_M.gguf', supportsVision: false, imagePartInstalled: false }],
    } as never)
    render(<ChatNotices />)
    expect(screen.getByTestId('chat-notices').textContent).toContain(COMPOSER_TEXT)
    expect(screen.queryByTestId('add-image-input')).toBeNull()
  })

  it('offers nothing for a model another runtime manages', () => {
    activeModel({ providerName: 'LM Studio', path: PATH, supportsVision: false, imagePartInstalled: false })
    render(<ChatNotices />)
    expect(screen.getByTestId('chat-notices').textContent).toContain(COMPOSER_TEXT)
    expect(screen.queryByTestId('add-image-input')).toBeNull()
  })
})
