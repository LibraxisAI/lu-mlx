/**
 * @vitest-environment jsdom
 *
 * Sending without a chat model must not lose the message.
 *
 * Found in the real Windows build of 3.0.5: with no chat model picked the Send
 * button was live, and a click with text (with or without attachments) emptied
 * the field and the chips. `sendMessage` and `sendInstruction` return without
 * a word when there is no model, and the composer cleared the draft anyway.
 *
 * The composer now asks first. Without a model nothing is handed over and
 * nothing is cleared, and the model picker is asked to open (uiStore
 * `modelAskSeq`), where the reason is written. The whole way through the real
 * app is in e2e/send-without-a-model-keeps-the-message.spec.ts.
 *
 * Run: npx vitest run src/components/chat/__tests__/senden-ohne-modell-verliert-nichts.test.tsx
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { ModelSelector } from '../../models/ModelSelector'
import { chatModelReady } from '../../../lib/chat-model-ready'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useUIStore } from '../../../stores/uiStore'

vi.mock('../../../hooks/useModels', async () => {
  const { useModelStore: store } = await import('../../../stores/modelStore')
  return {
    useModels: () => ({
      models: store((s) => s.models),
      activeModel: store((s) => s.activeModel),
      setActiveModel: store.getState().setActiveModel,
      fetchModels: async () => {},
    }),
  }
})

const TEXT = 'a message that must not get lost'
const LOCAL = 'qwen3:8b'
const CLOUD = 'lu-cloud::moonshotai/Kimi-K3'

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
const asked = () => useUIStore.getState().modelAskSeq

beforeEach(() => {
  cleanup()
  useModelStore.setState({ activeModel: null, models: [] } as never)
  useSettingsStore.getState().updateSettings({ appMode: 'local' })
  useUIStore.setState({ modelAskSeq: 0 })
})

describe('the composer with no chat model picked', () => {
  it('the Send button is live, a click sends nothing and keeps the text', () => {
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating={false} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    expect(sendButton().disabled).toBe(false)
    fireEvent.click(sendButton())
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe(TEXT)
    expect(asked()).toBe(1)
  })

  it('Enter does the same', () => {
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating={false} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe(TEXT)
    expect(asked()).toBe(1)
  })

  it('every further try asks again, and the draft is still there', () => {
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    fireEvent.click(sendButton())
    expect(asked()).toBe(2)
    expect(box().value).toBe(TEXT)
  })

  it('once a model is picked the kept message goes out and the field clears', () => {
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating={false} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    useModelStore.setState({ activeModel: LOCAL } as never)
    fireEvent.click(sendButton())
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(TEXT, undefined)
    expect(box().value).toBe('')
    expect(asked()).toBe(1)
  })

  it('COUNTER-CHECK: with a model picked the first send goes out and nothing is asked', () => {
    useModelStore.setState({ activeModel: LOCAL } as never)
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating={false} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(TEXT, undefined)
    expect(asked()).toBe(0)
  })

  it('the surface says what counts as ready: a refusal keeps the draft although a model is picked', () => {
    useModelStore.setState({ activeModel: LOCAL } as never)
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} onStop={() => {}} isGenerating={false} modelReady={() => false} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe(TEXT)
    expect(asked()).toBe(1)
  })
})

describe('what Chat counts as a model to send with', () => {
  it('nothing picked: not ready', () => {
    expect(chatModelReady()).toBe(false)
  })

  it('a local model in Local mode, a cloud model in Cloud mode: ready', () => {
    useModelStore.setState({ activeModel: LOCAL } as never)
    expect(chatModelReady()).toBe(true)
    useSettingsStore.getState().updateSettings({ appMode: 'cloud' })
    useModelStore.setState({ activeModel: CLOUD } as never)
    expect(chatModelReady()).toBe(true)
  })

  // sendMessage clears such a model and returns (the Cloud switch is a money
  // gate). The composer has to know before it clears the draft.
  it('a cloud model while the switch says Local: not ready, and the pick is cleared', () => {
    useModelStore.setState({ activeModel: CLOUD } as never)
    expect(chatModelReady()).toBe(false)
    expect(useModelStore.getState().activeModel).toBeNull()
  })
})

describe('the model picker after a send without a model', () => {
  const HINT = 'Choose a model to send your message. Your text and attachments are kept.'
  const picker = () => screen.getByRole('button', { name: 'Select chat model' })
  const withModels = () => useModelStore.setState({
    activeModel: null,
    models: [{ name: LOCAL, type: 'text', provider: 'ollama' }],
  } as never)

  it('stays closed and unmarked until a send asks for a model', () => {
    withModels()
    render(<ModelSelector openUpward />)
    expect(screen.queryByTestId('model-picker-menu')).toBeNull()
    expect(screen.queryByTestId('picker-send-needs-model-dot')).toBeNull()
  })

  it('opens by itself and says what is missing, in the menu', () => {
    withModels()
    render(<><ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} composerModel={<ModelSelector openUpward />} /></>)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    expect(screen.getByTestId('model-picker-menu')).toBeTruthy()
    expect(screen.getByTestId('picker-send-needs-model').textContent).toBe(HINT)
    expect(picker().getAttribute('aria-expanded')).toBe('true')
    expect(box().value).toBe(TEXT)
  })

  it('with no model listed the sentence says so', () => {
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} composerModel={<ModelSelector openUpward />} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    expect(screen.getByTestId('picker-send-needs-model').textContent)
      .toBe('Your message needs a chat model, and none is listed yet. Your text and attachments are kept.')
  })

  it('closed without a pick: the dot on the button stays, the sentence comes back on opening', () => {
    withModels()
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} composerModel={<ModelSelector openUpward />} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    fireEvent.click(picker())
    expect(screen.getByTestId('picker-send-needs-model-dot')).toBeTruthy()
    expect(picker().getAttribute('title')).toBe('Your message needs a chat model. Pick one here to send it.')
    fireEvent.click(picker())
    expect(screen.getByTestId('picker-send-needs-model')).toBeTruthy()
  })

  it('a picked model takes the dot and the sentence away', () => {
    withModels()
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} composerModel={<ModelSelector openUpward />} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    fireEvent.click(picker())
    useModelStore.setState({ activeModel: LOCAL } as never)
    cleanup()
    render(<ModelSelector openUpward />)
    expect(screen.queryByTestId('picker-send-needs-model-dot')).toBeNull()
    fireEvent.click(picker())
    expect(screen.queryByTestId('picker-send-needs-model')).toBeNull()
  })

  it('nothing of it is written in the composer: the sentence lives in the menu only', () => {
    withModels()
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} composerModel={<ModelSelector openUpward />} />)
    fireEvent.change(box(), { target: { value: TEXT } })
    fireEvent.click(sendButton())
    const menu = screen.getByTestId('model-picker-menu')
    const hits = screen.getAllByText(HINT)
    expect(hits).toHaveLength(1)
    expect(menu.contains(hits[0])).toBe(true)
  })
})
