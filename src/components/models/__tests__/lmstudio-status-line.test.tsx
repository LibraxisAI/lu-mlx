// @vitest-environment jsdom
/**
 * LM Studio in the local model list is one slim line.
 *
 * 05.10.2026: the box with three text blocks and a full-width button
 * (about 145 px, as tall as five model rows) becomes a single line: a state
 * dot, a short sentence, a small "Start" button. That starting it makes LM
 * Studio the local chat backend is said in the tooltip of the button only.
 * What the button does is unchanged.
 *
 * Run: npx vitest run src/components/models/__tests__/lmstudio-status-line.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AIModel } from '../../../types/models'
import type { ProviderConfig } from '../../../api/providers/types'

const OLLAMA_ROW = {
  name: 'qwen3:8b', model: 'qwen3:8b', size: 0, type: 'text', provider: 'ollama', providerName: 'Ollama',
} as AIModel
const lmStudioRow = (id: string) => ({
  name: `openai::${id}`, model: id, displayName: id, size: 0, type: 'text', provider: 'openai', providerName: 'LM Studio',
} as AIModel)
const LMS_ROWS = [lmStudioRow('qwen3-4b'), lmStudioRow('gemma-3-4b-it')]
let MODELS: AIModel[] = [OLLAMA_ROW]
let ACTIVE = 'qwen3:8b'

const fetchModels = vi.fn(async () => {})
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ models: MODELS, activeModel: ACTIVE, setActiveModel: vi.fn(), fetchModels }),
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
const backendCall = vi.fn(async (_cmd: string): Promise<unknown> => null)
vi.mock('../../../api/backend', () => ({ backendCall: (cmd: string) => backendCall(cmd), isTauri: () => false }))
vi.mock('../../../api/builtin-ensure', () => ({ diagnoseBuiltinEngine: vi.fn(async () => null) }))
// A closed menu is gone at once. The exit animation never ends in jsdom, and
// the menu would stay mounted, with the line in it.
vi.mock('framer-motion', async (actual) => ({
  ...(await actual<typeof import('framer-motion')>()),
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
}))

const { ModelSelector, lmStudioLineText, lmStudioStartTitle } = await import('../ModelSelector')
const { useProviderStore } = await import('../../../stores/providerStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { useModelStore } = await import('../../../stores/modelStore')
const { DEFAULT_SETTINGS } = await import('../../../lib/constants')

const OFF = { running: false, port: 1234, lms_present: true, models_detected: true, model_count: 7 }
const RUNNING = { ...OFF, running: true }

const slot = (extra: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'openai', name: 'LU Engine', enabled: true, baseUrl: 'http://127.0.0.1:8127/v1',
  apiKey: '', isLocal: true, managed: true, ...extra,
})
const setSlot = (config: ProviderConfig) =>
  useProviderStore.setState((s) => ({ providers: { ...s.providers, openai: config } }))

const line = () => screen.queryByTestId('lmstudio-status-line')
const startButton = () => screen.getByRole('button', { name: 'Start' })

/** Open the menu and let the status probe answer. */
async function open(status: unknown, mode: 'local' | 'cloud' = 'local') {
  let serverStatus = status
  backendCall.mockImplementation(async (cmd) => (cmd === 'lmstudio_server_status' ? serverStatus : null))
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: mode } })
  render(createElement(ModelSelector))
  await act(async () => { fireEvent.click(screen.getByLabelText('Select chat model')) })
  // The selector loads its list on mount and on open. What counts below is a
  // reload the line asked for.
  fetchModels.mockClear()
  return { setStatus: (s: unknown) => { serverStatus = s } }
}

beforeEach(() => {
  cleanup()
  backendCall.mockReset()
  fetchModels.mockClear()
  MODELS = [OLLAMA_ROW]
  ACTIVE = 'qwen3:8b'
  useModelStore.setState({ foldedRows: null, inventoryLoaded: true } as never)
  setSlot(slot({}))
  useProviderStore.setState({ engineOptedOut: false })
})
afterEach(() => { vi.useRealTimers(); cleanup() })

describe('the sentence', () => {
  it('names the state and what is on disk, in one short line', () => {
    expect(lmStudioLineText(7, false, false)).toBe('LM Studio server off, 7 models on disk')
    expect(lmStudioLineText(1, false, false)).toBe('LM Studio server off, 1 model on disk')
    expect(lmStudioLineText(7, true, false)).toBe('LM Studio server starting')
    expect(lmStudioLineText(7, false, true)).toBe('LM Studio server did not start')
  })

  it('says what "Start" replaces only in the tooltip, and only when it replaces something', () => {
    expect(lmStudioStartTitle(true)).toContain('This also makes LM Studio your local chat backend in place of the LU Engine.')
    expect(lmStudioStartTitle(true)).toContain('You can switch back under Settings, AI Backends, Providers.')
    expect(lmStudioStartTitle(false)).toBe('Start the LM Studio server to pick its models here.')
  })
})

describe('the line in the local list', () => {
  it('is one line: a dot, the sentence, a small Start button', async () => {
    await open(OFF)
    const el = line()!
    expect(el.className).toContain('lu-picker-service')
    expect(el.getAttribute('data-state')).toBe('off')
    expect(el.querySelector('.lu-picker-dot')).toBeTruthy()
    expect(el.querySelector('.st')!.textContent).toBe('LM Studio server off, 7 models on disk')
    expect(el.querySelectorAll('button')).toHaveLength(1)
    expect(startButton().className).toContain('lu-picker-text-btn')
    // Nothing of the old box: no paragraphs, no wide button, no dismiss.
    expect(el.querySelectorAll('p')).toHaveLength(0)
    expect(el.textContent).toBe('LM Studio server off, 7 models on disk' + 'Start')
    expect(screen.queryByLabelText(/Dismiss \(returns on next launch\)/)).toBeNull()
  })

  it('keeps the backend sentence out of the line and in the tooltip of the button', async () => {
    await open(OFF)
    expect(line()!.textContent).not.toMatch(/chat backend/)
    expect(startButton().getAttribute('title')).toContain('This also makes LM Studio your local chat backend')
  })

  it('does not threaten a takeover when the LU Engine does not hold the slot', async () => {
    setSlot(slot({ name: 'LM Studio', managed: false, baseUrl: 'http://localhost:1234/v1' }))
    await open(OFF)
    expect(startButton().getAttribute('title')).toBe('Start the LM Studio server to pick its models here.')
  })

  it('stays away when the server runs, and when LM Studio is not on this machine', async () => {
    await open(RUNNING)
    expect(line()).toBeNull()
    cleanup()
    await open({ running: false, port: 1234, lms_present: false, models_detected: false, model_count: 0 })
    expect(line()).toBeNull()
  })

  it('stays away in Cloud mode, where the list holds hosted models only', async () => {
    await open(OFF, 'cloud')
    expect(line()).toBeNull()
  })

  it('leaves the local list itself as it was: rows as buttons under it', async () => {
    await open(OFF)
    const menu = screen.getByTestId('model-picker-menu')
    expect(menu.getAttribute('data-picker')).toBe('local')
    expect(menu.querySelectorAll('[role="button"]')).toHaveLength(1)
    expect(menu.querySelector('[role="option"]')).toBeNull()
    expect(screen.queryByTestId('model-picker-search')).toBeNull()
  })
})

describe('Start', () => {
  it('starts the server, hands LM Studio the slot and reloads the list, as before', async () => {
    vi.useFakeTimers()
    const probe = await open(OFF)
    await act(async () => { fireEvent.click(startButton()) })
    expect(backendCall).toHaveBeenCalledWith('start_lmstudio_server')
    expect(line()!.getAttribute('data-state')).toBe('starting')
    expect(line()!.querySelector('.st')!.textContent).toBe('LM Studio server starting')
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    probe.setStatus(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(fetchModels).toHaveBeenCalled()
    const openai = useProviderStore.getState().providers.openai
    expect(openai.managed).toBe(false)
    expect(openai.baseUrl).toContain('1234')
    // The server runs: the line has done its job and is gone.
    expect(line()).toBeNull()
  })

  it('turns red and offers Retry when the start fails, with the reason behind the sentence', async () => {
    await open(OFF)
    backendCall.mockImplementation(async (cmd) => {
      if (cmd === 'start_lmstudio_server') throw 'lms: command not found'
      return OFF
    })
    await act(async () => { fireEvent.click(startButton()) })
    const el = line()!
    expect(el.getAttribute('data-state')).toBe('failed')
    expect(el.className).toContain('is-err')
    expect(el.querySelector('.st')!.textContent).toBe('LM Studio server did not start')
    expect(el.querySelector('.st')!.getAttribute('title')).toBe('lms: command not found')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

// Windows box, 05.10.2026: after "Start" the models came into the list, and
// the line above them kept saying "server off" for as long as the menu stayed
// open. It asked the server once on open and for six seconds after the click.
describe('the line follows the server while the menu is open', () => {
  const statusCalls = () => backendCall.mock.calls.filter(([cmd]) => cmd === 'lmstudio_server_status').length

  it('a server that needs longer than a few seconds still takes the line away and brings its models', async () => {
    vi.useFakeTimers()
    const probe = await open(OFF)
    await act(async () => { fireEvent.click(startButton()) })
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(line()!.getAttribute('data-state')).toBe('starting')
    expect(fetchModels).not.toHaveBeenCalled()
    probe.setStatus(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()).toBeNull()
    expect(fetchModels).toHaveBeenCalled()
    expect(useProviderStore.getState().providers.openai.baseUrl).toContain('1234')
  })

  it('gives the Start button back after the wait, and still follows a server that comes late', async () => {
    vi.useFakeTimers()
    const probe = await open(OFF)
    await act(async () => { fireEvent.click(startButton()) })
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(line()!.getAttribute('data-state')).toBe('off')
    expect(startButton()).toBeTruthy()
    probe.setStatus(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()).toBeNull()
    expect(useProviderStore.getState().providers.openai.managed).toBe(false)
  })

  it('a server started somewhere else takes the line away, reloads the list and takes no slot', async () => {
    vi.useFakeTimers()
    const probe = await open(OFF)
    probe.setStatus(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()).toBeNull()
    expect(fetchModels).toHaveBeenCalledTimes(1)
    const openai = useProviderStore.getState().providers.openai
    expect(openai.managed).toBe(true)
    expect(openai.baseUrl).toContain('8127')
  })

  it('a server that stops brings the line back, with the count of that moment', async () => {
    vi.useFakeTimers()
    const probe = await open(RUNNING)
    expect(line()).toBeNull()
    probe.setStatus({ ...OFF, model_count: 3 })
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()!.querySelector('.st')!.textContent).toBe('LM Studio server off, 3 models on disk')
    // Nothing came up, so nothing is reloaded.
    expect(fetchModels).not.toHaveBeenCalled()
  })

  it('one failed answer does not end the following', async () => {
    vi.useFakeTimers()
    const probe = await open(OFF)
    backendCall.mockImplementationOnce(async () => { throw 'lmstudio_server_status task: cancelled' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()!.getAttribute('data-state')).toBe('off')
    probe.setStatus(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()).toBeNull()
  })

  it('asks once and then leaves it when LM Studio is not on this machine', async () => {
    vi.useFakeTimers()
    await open({ running: false, port: 1234, lms_present: false, models_detected: false, model_count: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(statusCalls()).toBe(1)
  })

  it('asks once and then leaves it where the question itself fails (no Tauri)', async () => {
    vi.useFakeTimers()
    backendCall.mockImplementation(async () => { throw 'not running (e2e)' })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'local' } })
    render(createElement(ModelSelector))
    await act(async () => { fireEvent.click(screen.getByLabelText('Select chat model')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(line()).toBeNull()
    expect(statusCalls()).toBe(1)
  })

  it('stops asking when the menu closes', async () => {
    vi.useFakeTimers()
    await open(OFF)
    await act(async () => { await vi.advanceTimersByTimeAsync(3200) })
    const before = statusCalls()
    expect(before).toBeGreaterThan(1)
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(statusCalls()).toBe(before)
  })
})

// Windows box, 05.10.2026 (probe 7): the server was stopped from outside, the
// line came back after 2 to 3 s, and the seven LM Studio models stood under
// "server off" for 160 s, also after closing and reopening the menu.
describe('the models of a stopped server leave the list', () => {
  const rowNames = () => Array.from(
    screen.getByTestId('model-picker-menu').querySelectorAll('[role="button"]'),
  ).map((row) => row.textContent ?? '')
  const lmsRows = () => rowNames().filter((text) => text.includes('LM Studio'))
  const trigger = () => screen.getByLabelText('Select chat model')

  beforeEach(() => { MODELS = [OLLAMA_ROW, ...LMS_ROWS] })

  it('lists them while the server runs', async () => {
    await open(RUNNING)
    expect(lmsRows()).toHaveLength(2)
    expect(rowNames()).toHaveLength(3)
  })

  it('takes them out as soon as the line says "server off", and leaves the other rows', async () => {
    vi.useFakeTimers()
    const probe = await open(RUNNING)
    probe.setStatus(OFF)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()!.getAttribute('data-state')).toBe('off')
    expect(lmsRows()).toHaveLength(0)
    expect(rowNames()).toHaveLength(1)
    expect(rowNames()[0]).toContain('qwen3:8b')
  })

  it('keeps them out when the menu is closed and opened again', async () => {
    await open(OFF)
    expect(lmsRows()).toHaveLength(0)
    await act(async () => { fireEvent.click(trigger()) })
    expect(screen.queryByTestId('model-picker-menu')).toBeNull()
    // A new line, which knows nothing yet: the list keeps the last answer.
    await act(async () => { fireEvent.click(trigger()) })
    expect(lmsRows()).toHaveLength(0)
    expect(rowNames()).toHaveLength(1)
  })

  it('keeps the pick: the button still names the chosen LM Studio model', async () => {
    ACTIVE = LMS_ROWS[0].name
    await open(OFF)
    expect(lmsRows()).toHaveLength(0)
    expect(trigger().textContent).toContain('qwen3-4b')
  })

  it('brings them back once the server is up after Start', async () => {
    vi.useFakeTimers()
    const probe = await open(OFF)
    await act(async () => { fireEvent.click(startButton()) })
    expect(lmsRows()).toHaveLength(0)
    probe.setStatus(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(line()).toBeNull()
    expect(lmsRows()).toHaveLength(2)
  })

  it('says the list is empty when LM Studio had the only models', async () => {
    MODELS = [...LMS_ROWS]
    await open(OFF)
    expect(rowNames()).toHaveLength(0)
    expect(screen.getByTestId('model-picker-menu').textContent).toContain('No models available')
  })
})
