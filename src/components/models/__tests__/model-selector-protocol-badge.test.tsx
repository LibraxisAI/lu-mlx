// @vitest-environment jsdom
/**
 * ModelSelector disambiguates two enabled OpenAI-compatible cards pointing at
 * the same endpoint (for example Chat Completions vs Responses API).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AIModel } from '../../../types/models'
import type { ProviderConfig } from '../../../api/providers/types'
import {
  duplicateModelDisplayNames,
  modelProtocolBadge,
  resolveModelApiProtocol,
  resolveModelProviderConfig,
} from '../../../lib/model-protocol-badge'

let MODELS: AIModel[] = []
let ACTIVE: string | null = null

vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({
    models: MODELS,
    activeModel: ACTIVE,
    setActiveModel: vi.fn(),
    fetchModels: vi.fn(async () => {}),
  }),
}))
vi.mock('../../../api/lmstudio', () => ({
  loadLmStudioModel: vi.fn(async () => {}),
  unloadLmStudioModel: vi.fn(async () => {}),
  listLoadedLmStudioModels: vi.fn(async () => [] as string[]),
}))
vi.mock('../../../api/ollama', () => ({
  listRunningModels: vi.fn(async () => [] as string[]),
  loadModel: vi.fn(async () => {}),
  unloadModel: vi.fn(async () => {}),
  unloadAllModels: vi.fn(async () => {}),
}))
vi.mock('../../../api/backend', () => ({ backendCall: vi.fn(async () => null), isTauri: () => false }))
vi.mock('../../../api/builtin-ensure', () => ({ diagnoseBuiltinEngine: vi.fn(async () => null) }))
vi.mock('framer-motion', async (actual) => ({
  ...(await actual<typeof import('framer-motion')>()),
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
}))

const { ModelSelector } = await import('../ModelSelector')
const { useProviderStore } = await import('../../../stores/providerStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { useModelStore } = await import('../../../stores/modelStore')
const { DEFAULT_SETTINGS } = await import('../../../lib/constants')

const openRouterSlot: ProviderConfig = {
  id: 'openai',
  name: 'OpenRouter',
  enabled: true,
  baseUrl: 'https://api.libraxis.com/v1',
  apiKey: 'sk-1',
  isLocal: false,
  managed: false,
}

const customResponsesEntry: ProviderConfig = {
  id: 'openai',
  entryId: 'custom-795e',
  name: 'Custom (OpenAI-compat)',
  enabled: true,
  baseUrl: 'https://api.libraxis.com/v1',
  apiKey: 'sk-2',
  isLocal: false,
  managed: false,
  apiProtocol: 'responses',
  responsesTransport: 'auto',
}

const chatRow: AIModel = {
  name: 'openai::big-buddy-low',
  model: 'big-buddy-low',
  size: 0,
  type: 'text',
  provider: 'openai',
  providerName: 'OpenRouter',
}

const responsesRow: AIModel = {
  name: 'openai:custom-795e::big-buddy-low',
  model: 'big-buddy-low',
  size: 0,
  type: 'text',
  provider: 'openai',
  providerName: 'Custom (OpenAI-compat)',
  providerEntry: 'custom-795e',
}

const ollamaRow: AIModel = {
  name: 'qwen3:8b',
  model: 'qwen3:8b',
  size: 0,
  type: 'text',
  provider: 'ollama',
  providerName: 'Ollama',
}

beforeEach(() => {
  cleanup()
  MODELS = []
  ACTIVE = null
  useModelStore.setState({ foldedRows: null, inventoryLoaded: true } as never)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'local' } })
  useProviderStore.setState((s) => ({
    providers: { ...s.providers, openai: openRouterSlot },
    openaiEntries: [customResponsesEntry],
    engineOptedOut: false,
  }))
})

afterEach(() => {
  cleanup()
})

describe('model-protocol-badge helpers', () => {
  it('resolves slot vs entry protocol and skips managed / non-OpenAI models', () => {
    const providers = useProviderStore.getState().providers
    expect(resolveModelProviderConfig('openai::big-buddy-low', providers, [customResponsesEntry])?.name)
      .toBe('OpenRouter')
    expect(resolveModelApiProtocol('openai::big-buddy-low', providers, [customResponsesEntry]))
      .toBe('chat_completions')
    expect(resolveModelApiProtocol('openai:custom-795e::big-buddy-low', providers, [customResponsesEntry]))
      .toBe('responses')
    expect(resolveModelApiProtocol('qwen3:8b', providers, [customResponsesEntry])).toBeNull()
    expect(
      resolveModelApiProtocol(
        'openai::built-in.gguf',
        { ...providers, openai: { ...openRouterSlot, managed: true, apiProtocol: 'responses' } },
        [],
      ),
    ).toBeNull()
  })

  it('shows Responses always, Chat only on duplicate labels', () => {
    expect(modelProtocolBadge('responses', false)).toEqual({
      short: 'Responses',
      long: 'Responses API (/v1/responses)',
      isResponses: true,
    })
    expect(modelProtocolBadge('chat_completions', false)).toBeNull()
    expect(modelProtocolBadge('chat_completions', true)).toEqual({
      short: 'Chat',
      long: 'Chat Completions (/v1/chat/completions)',
      isResponses: false,
    })
    const dupes = duplicateModelDisplayNames([chatRow, responsesRow, ollamaRow])
    expect(dupes.has('big-buddy-low')).toBe(true)
    expect(dupes.has('qwen3:8b')).toBe(false)
  })
})

describe('ModelSelector protocol disambiguation', () => {
  it('marks duplicate endpoint cards cleanly in dropdown and active trigger', async () => {
    MODELS = [chatRow, responsesRow]
    ACTIVE = chatRow.name
    render(createElement(ModelSelector))

    const trigger = screen.getByLabelText('Select chat model')
    expect(screen.getByTestId('active-model-protocol').textContent).toBe('OpenRouter · Chat')
    expect(trigger.getAttribute('title')).toContain('OpenRouter · Chat Completions')

    await act(async () => {
      fireEvent.click(trigger)
    })

    const badges = screen.getAllByTestId('model-protocol-badge').map((el) => el.textContent)
    expect(badges).toEqual(['Chat', 'Responses'])

    cleanup()
    ACTIVE = responsesRow.name
    render(createElement(ModelSelector))
    const respTrigger = screen.getByLabelText('Select chat model')
    expect(screen.getByTestId('active-model-protocol').textContent).toBe('Custom (OpenAI-compat) · Responses')
    expect(respTrigger.getAttribute('title')).toContain('Custom (OpenAI-compat) · Responses API')
  })

  it('stays quiet for single non-Responses providers (Ollama / single Chat slot)', async () => {
    MODELS = [ollamaRow, chatRow]
    ACTIVE = chatRow.name
    useProviderStore.setState({ openaiEntries: [] })
    render(createElement(ModelSelector))

    expect(screen.queryByTestId('active-model-protocol')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select chat model'))
    })
    expect(screen.queryAllByTestId('model-protocol-badge')).toHaveLength(0)
  })
})
