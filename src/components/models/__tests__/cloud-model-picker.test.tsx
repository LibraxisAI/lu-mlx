// @vitest-environment jsdom
/**
 * The new model picker in Cloud mode, on the real component.
 *
 * 05.10.2026, the owner's decisions on the approved draft: grouped by family with
 * one-line heads, a search on top, chips that narrow the list, a footer with
 * the count, and a keyboard that works from the search field. The row shows
 * the name, the measured mark, vision, thinking and the context window the
 * server stated. It shows NO credit column: a tiny question mark at the end of
 * the row opens the model's credit rates per one million tokens, input and
 * output apart.
 *
 * HARD RULE held at the bottom of this file: credits per token count only,
 * never a money amount, never how many tokens a sum of money buys.
 *
 * Run: npx vitest run src/components/models/__tests__/cloud-model-picker.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PICKER_FIXTURE, pickerFixtureModels } from '../../../lib/__tests__/model-picker-fixture'
import type { ModelSelectorProps } from '../ModelSelector'

const setActiveModel = vi.fn()
vi.mock('../../../hooks/useModels', async () => {
  const { useModelStore: store } = await import('../../../stores/modelStore')
  return {
    useModels: () => ({
      models: store((s) => s.models),
      activeModel: store((s) => s.activeModel),
      setActiveModel,
      fetchModels: async () => {},
    }),
  }
})
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
vi.mock('../../../api/backend', () => ({ backendCall: (cmd: string) => backendCall(cmd) }))
vi.mock('../../../api/builtin-ensure', () => ({ diagnoseBuiltinEngine: vi.fn(async () => null) }))

const { ModelSelector } = await import('../ModelSelector')
const { useModelStore } = await import('../../../stores/modelStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { useCloudAuthStore } = await import('../../../stores/cloudAuthStore')
const { useUIStore } = await import('../../../stores/uiStore')
const { useLuEngineSwitchStore } = await import('../../../stores/luEngineSwitchStore')
const { DEFAULT_SETTINGS } = await import('../../../lib/constants')

const MODELS = pickerFixtureModels()
const TOTAL = PICKER_FIXTURE.length
const ACTIVE = 'lu-cloud::Qwen/Qwen3.6-27B'

const trigger = () => screen.getByRole('button', { name: 'Select chat model' })
const menu = () => screen.getByTestId('model-picker-menu')
const search = () => screen.getByTestId('model-picker-search') as HTMLInputElement
const isOpen = () => trigger().getAttribute('aria-expanded') === 'true'
const rows = () => Array.from(menu().querySelectorAll<HTMLElement>('[role="option"]'))
const labels = () => rows().map((r) => r.querySelector('.lu-picker-name')!.textContent)
const heads = () => Array.from(menu().querySelectorAll<HTMLElement>('.lu-picker-head b')).map((b) => b.textContent)
const chip = (f: string) => menu().querySelector<HTMLElement>(`[data-chip="${f}"]`)
const count = () => screen.getByTestId('model-picker-count').textContent
const cursorRow = () => menu().querySelector<HTMLElement>('[role="option"][data-cursor="true"]')
const row = (label: string) => rows().find((r) => r.querySelector('.lu-picker-name')!.textContent === label)!
const rateButton = (label: string) => row(label).querySelector<HTMLButtonElement>('.lu-picker-rate-btn')
const ratePopover = () => screen.queryByTestId('model-rate-popover')
const type = (text: string) => fireEvent.change(search(), { target: { value: text } })
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? search(), { key: k })

function signIn(paidPlan: boolean | null) {
  useCloudAuthStore.getState().setSignedIn(
    { id: 'u1' },
    { licenseActive: true, tier: 'hosted', access: true, quota: null, paidPlan },
  )
}

function open(active: string | null = ACTIVE, props: ModelSelectorProps = {}) {
  useModelStore.setState({ models: MODELS, activeModel: active, inventoryLoaded: true } as never)
  render(<ModelSelector openUpward {...props} />)
  fireEvent.click(trigger())
}

beforeEach(() => {
  cleanup()
  setActiveModel.mockClear()
  backendCall.mockClear()
  backendCall.mockImplementation(async () => null)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud' } })
  useModelStore.setState({ models: [], activeModel: null, foldedRows: null, inventoryLoaded: true } as never)
  useLuEngineSwitchStore.getState().dismiss()
  useUIStore.setState({ modelAskSeq: 0 })
  signIn(true)
})
afterEach(() => { cleanup() })

describe('the open picker', () => {
  it('is the Cloud picker, not the local list', () => {
    open()
    expect(menu().getAttribute('data-picker')).toBe('cloud')
    expect(menu().className).toContain('lu-picker')
    expect(menu().querySelectorAll('[role="button"]')).toHaveLength(0)
  })

  it('lists every model under one-line family heads, Other last', () => {
    open()
    expect(rows()).toHaveLength(TOTAL)
    expect(heads()).toEqual(['Qwen', 'DeepSeek', 'Llama', 'Other'])
    expect(count()).toBe(`${TOTAL} cloud models`)
  })

  it('writes the head count next to the family', () => {
    open()
    expect(menu().querySelector('[data-family="Qwen"] .n')!.textContent).toBe('4')
    expect(menu().querySelector('[data-family="Other"] .n')!.textContent).toBe('2')
  })

  it('shows the catalogue label on the row and on the trigger, the id in the hover', () => {
    open()
    expect(trigger().textContent).toContain('Qwen 3.6 27B')
    expect(row('Qwen 3.6 27B').getAttribute('title')).toBe('Qwen/Qwen3.6-27B')
  })

  it('marks the selected row for a screen reader and puts the cursor on it', () => {
    open()
    expect(row('Qwen 3.6 27B').getAttribute('aria-selected')).toBe('true')
    expect(cursorRow()).toBe(row('Qwen 3.6 27B'))
    expect(rows().filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })

  it('puts the keyboard into the search field', () => {
    open()
    expect(document.activeElement).toBe(search())
    expect(search().getAttribute('aria-activedescendant')).toBe(cursorRow()!.id)
  })

  it('says in the footer that the list is the hosted one, and how to get the local one', () => {
    open()
    expect(screen.getByTestId('model-picker-count').getAttribute('title'))
      .toBe('Cloud mode shows hosted models only. Switch the app to Local mode to use Ollama, LM Studio or the LU Engine.')
  })

  it('has no LM Studio line and no unload button: those belong to the local list', async () => {
    backendCall.mockImplementation(async (cmd) => cmd === 'lmstudio_server_status'
      ? { running: false, port: 1234, lms_present: true, models_detected: true, model_count: 7 }
      : null)
    open()
    await Promise.resolve()
    expect(screen.queryByTestId('lmstudio-status-line')).toBeNull()
    expect(menu().textContent).not.toMatch(/Unload all/)
  })
})

describe('a row', () => {
  it('carries the measured mark only where it was measured full', () => {
    open()
    expect(row('Qwen 3.6 27B').querySelector('[data-mark="unfiltered"]')!.textContent).toBe('No Filter')
    expect(row('Qwen3 30B A3B').querySelector('[data-mark="unfiltered"]')).toBeNull()
    expect(row('Llama 4 Scout').querySelector('[data-mark="unfiltered"]')).toBeNull()
  })

  it('shows the eye and the bulb only where the server stated them', () => {
    open()
    expect(row('Qwen 3.6 27B').querySelector('[data-icon="vision"] svg')).toBeTruthy()
    expect(row('Qwen 3.6 27B').querySelector('[data-icon="thinking"] svg')).toBeTruthy()
    expect(row('Llama 3.1 8B Turbo').querySelector('[data-icon="vision"]')).toBeNull()
    expect(row('Llama 3.1 8B Turbo').querySelector('[data-icon="thinking"]')).toBeNull()
  })

  it('prints the context window in the app spelling, and leaves it empty where none was stated', () => {
    open()
    expect(row('Qwen 3.6 27B').querySelector('[data-context]')!.textContent).toBe('256K')
    expect(row('Qwen3 30B A3B').querySelector('[data-context]')!.textContent).toBe('40K')
    // Kimi K3 budgets with 8192 in the fixture. That number is not printed.
    expect(row('Kimi K3').querySelector('[data-context]')!.textContent).toBe('')
  })

  it('says on a tight context window that Agent and Code will not fit', () => {
    open()
    expect(row('MythoMax L2 13B').querySelector('[data-context]')!.getAttribute('title')).toMatch(/too small/)
    expect(row('Qwen 3.6 27B').querySelector('[data-context]')!.getAttribute('title')).toBeNull()
  })

  it('tags a model that cannot call tools as chat only', () => {
    open()
    expect(row('MythoMax L2 13B').querySelector('[data-mark="chat-only"]')!.textContent).toBe('Chat only')
    expect(row('Qwen 3.6 27B').querySelector('[data-mark="chat-only"]')).toBeNull()
  })

  it('writes the quiet note behind the name of a model with little room, and on no other', () => {
    const models = MODELS.map((m) => (m.name === ACTIVE ? { ...m, limitedCapacity: true } : m))
    useModelStore.setState({ models, activeModel: ACTIVE, inventoryLoaded: true } as never)
    render(<ModelSelector openUpward />)
    fireEvent.click(trigger())
    const notes = Array.from(menu().querySelectorAll<HTMLElement>('[data-note="limited-capacity"]'))
    expect(notes).toHaveLength(1)
    const note = row('Qwen 3.6 27B').querySelector<HTMLElement>('[data-note="limited-capacity"]')!
    expect(note.textContent).toBe('Limited capacity')
    // A note, not a mark: none of the tag classes, and it follows the name.
    expect(note.className).toBe('lu-picker-quiet')
    expect(note.previousElementSibling === row('Qwen 3.6 27B').querySelector('.lu-picker-name')
      || note.parentElement!.firstElementChild === row('Qwen 3.6 27B').querySelector('.lu-picker-name')).toBe(true)
    // The trigger at the chat input does not repeat it.
    expect(trigger().textContent).not.toMatch(/limited/i)
    // The style sheet gives it no frame and no fill.
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    const rule = css.slice(css.indexOf('.lu-picker-quiet {'), css.indexOf('}', css.indexOf('.lu-picker-quiet {')))
    expect(rule).toMatch(/color: var\(--pk-t3\)/)
    expect(rule).not.toMatch(/border|background|accent/)
  })

  it('has no credit column and no "No credits" word in the row', () => {
    open()
    for (const r of rows()) {
      expect(r.querySelector('.lu-picker-pick')!.textContent).not.toMatch(/credit/i)
    }
  })

  it('picks its model and closes the menu', () => {
    open()
    fireEvent.click(row('DeepSeek V3.2').querySelector('.lu-picker-pick')!)
    expect(setActiveModel).toHaveBeenCalledWith('lu-cloud::deepseek-ai/DeepSeek-V3.2')
    expect(isOpen()).toBe(false)
  })
})

describe('search', () => {
  it('narrows the list as the user types and drops the heads', () => {
    open()
    type('qwen 3.6')
    expect(labels()).toEqual(['Qwen 3.6 27B'])
    expect(heads()).toEqual([])
    expect(count()).toBe(`1 of ${TOTAL}`)
  })

  it('underlines what the words hit', () => {
    open()
    type('deep')
    expect(Array.from(row('DeepSeek V3.2').querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['Deep'])
  })

  it('finds a model by its id', () => {
    open()
    type('moonshotai')
    expect(labels()).toEqual(['Kimi K3'])
  })

  it('says so when nothing matches, in words the copy rules allow', () => {
    open()
    type('no such model')
    expect(rows()).toHaveLength(0)
    expect(screen.getByTestId('model-picker-no-match').textContent).toBe('No models match. Clear the search or a tag.')
  })

  it('"Clear" empties the field and brings the heads back', () => {
    open()
    type('qwen')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(search().value).toBe('')
    expect(rows()).toHaveLength(TOTAL)
    expect(heads()).toContain('Qwen')
  })
})

describe('chips', () => {
  it('stand in the fixed order with their counts', () => {
    open()
    const all = Array.from(menu().querySelectorAll<HTMLElement>('[data-chip]'))
    expect(all.map((c) => c.getAttribute('data-chip'))).toEqual(['marked', 'vision', 'thinking', 'free'])
    expect(chip('marked')!.textContent).toBe('No Filter 4')
    expect(chip('vision')!.textContent).toBe('Vision 2')
    expect(chip('thinking')!.textContent).toBe('Thinking 7')
    expect(chip('free')!.textContent).toBe('No credits 1')
  })

  it('narrow the list when pressed and give it back when pressed again', () => {
    open()
    fireEvent.click(chip('marked')!)
    expect(chip('marked')!.getAttribute('aria-pressed')).toBe('true')
    expect(labels()).toEqual(['Qwen 3.6 27B', 'Qwen 3.8 A95B', 'DeepSeek V3.2', 'MythoMax L2 13B'])
    expect(count()).toBe(`4 of ${TOTAL}`)
    fireEvent.click(chip('marked')!)
    expect(chip('marked')!.getAttribute('aria-pressed')).toBe('false')
    expect(rows()).toHaveLength(TOTAL)
  })

  it('combine: two pressed chips must both hold', () => {
    open()
    fireEvent.click(chip('marked')!)
    fireEvent.click(chip('vision')!)
    expect(labels()).toEqual(['Qwen 3.6 27B'])
  })

  it('offer no "No credits" chip to an account that pays for every model', () => {
    signIn(false)
    open()
    expect(chip('free')).toBeNull()
    expect(chip('marked')).toBeTruthy()
  })
})

describe('the keyboard', () => {
  it('moves the cursor with the arrows from the search field, and Enter picks', () => {
    open()
    expect(cursorRow()).toBe(row('Qwen 3.6 27B'))
    key('ArrowDown')
    expect(cursorRow()).toBe(row('Qwen 3.8 A95B'))
    key('ArrowUp')
    key('ArrowUp')
    expect(cursorRow()).toBe(row('Qwen3 32B'))
    key('Enter')
    expect(setActiveModel).toHaveBeenCalledWith('lu-cloud::Qwen/Qwen3-32B')
    expect(isOpen()).toBe(false)
  })

  it('jumps with Home and End while the field is empty', () => {
    open()
    key('End')
    expect(cursorRow()).toBe(rows()[TOTAL - 1])
    key('Home')
    expect(cursorRow()).toBe(rows()[0])
  })

  it('starts at the first hit of a search, and Enter picks it', () => {
    open()
    type('deepseek')
    expect(cursorRow()).toBe(row('DeepSeek V3.2'))
    key('ArrowDown')
    key('Enter')
    expect(setActiveModel).toHaveBeenCalledWith('lu-cloud::deepseek-ai/DeepSeek-R2')
  })

  it('Escape empties the search first and closes the menu second', () => {
    open()
    type('qwen')
    key('Escape')
    expect(search().value).toBe('')
    expect(isOpen()).toBe(true)
    key('Escape')
    expect(isOpen()).toBe(false)
  })

  it('gives the keyboard back to the trigger when the menu closes', () => {
    open()
    trigger().focus()
    cleanup()
    // Opened from the trigger with the keyboard on it.
    useModelStore.setState({ models: MODELS, activeModel: ACTIVE, inventoryLoaded: true } as never)
    render(<ModelSelector openUpward />)
    trigger().focus()
    fireEvent.click(trigger())
    expect(document.activeElement).toBe(search())
    key('Escape')
    expect(document.activeElement).toBe(trigger())
  })

  it('keeps the rows out of the Tab order, the keyboard reaches them through the cursor', () => {
    open()
    for (const r of rows()) {
      expect(r.querySelector('.lu-picker-pick')!.getAttribute('tabindex')).toBe('-1')
    }
    // Exactly one rate control can be tabbed to: the one of the cursor row.
    const tabbable = Array.from(menu().querySelectorAll('.lu-picker-rate-btn')).filter((b) => b.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(row('Qwen 3.6 27B').contains(tabbable[0])).toBe(true)
  })
})

describe('the rate popover', () => {
  it('is closed until the question mark is pressed', () => {
    open()
    expect(ratePopover()).toBeNull()
    expect(rateButton('Qwen 3.6 27B')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the credit rates of that model per one million tokens, input and output apart', () => {
    open()
    fireEvent.click(rateButton('Qwen 3.6 27B')!)
    const pop = ratePopover()!
    expect(pop.querySelector('h4')!.textContent).toBe('Credits per 1M tokens')
    expect(pop.querySelector('[data-rate="input"]')!.textContent).toBe('32,000')
    expect(pop.querySelector('[data-rate="output"]')!.textContent).toBe('320,000')
    expect(rateButton('Qwen 3.6 27B')!.getAttribute('aria-expanded')).toBe('true')
    expect(rateButton('Qwen 3.6 27B')!.getAttribute('aria-describedby')).toBe(pop.id)
  })

  it('opens from the keyboard: the control is a real button, so focus and Enter press it', () => {
    open()
    const button = rateButton('Qwen 3.6 27B')!
    expect(button.tagName).toBe('BUTTON')
    button.focus()
    // Enter on a focused button is a click in every browser. The menu must
    // not take that Enter for a pick of the cursor row.
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(setActiveModel).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(ratePopover()).toBeTruthy()
    expect(isOpen()).toBe(true)
  })

  it('does not pick the model and does not close the menu', () => {
    open()
    fireEvent.click(rateButton('DeepSeek R2')!)
    expect(setActiveModel).not.toHaveBeenCalled()
    expect(isOpen()).toBe(true)
    // A press on the popover itself, which is lifted out to the body, is not
    // a press outside the menu.
    fireEvent.mouseDown(ratePopover()!)
    expect(isOpen()).toBe(true)
  })

  it('switches to another row, and closes on a second press', () => {
    open()
    fireEvent.click(rateButton('Qwen 3.6 27B')!)
    fireEvent.click(rateButton('DeepSeek R2')!)
    expect(screen.getAllByTestId('model-rate-popover')).toHaveLength(1)
    expect(ratePopover()!.querySelector('[data-rate="input"]')!.textContent).toBe('50,000')
    fireEvent.click(rateButton('DeepSeek R2')!)
    expect(ratePopover()).toBeNull()
  })

  it('Escape puts the rates away before anything else', () => {
    open()
    fireEvent.click(rateButton('Qwen 3.6 27B')!)
    rateButton('Qwen 3.6 27B')!.focus()
    key('Escape')
    expect(ratePopover()).toBeNull()
    expect(isOpen()).toBe(true)
  })

  it('offers no question mark where the server sent no rates: nothing wrong is shown', () => {
    open()
    expect(rateButton('Kimi K3')).toBeNull()
    expect(rateButton('Qwen 3.6 27B')).toBeTruthy()
  })

  it('offers none at all on a server that does not send the field yet', () => {
    useModelStore.setState({
      models: MODELS.map((m) => ({ ...m, creditRates: undefined, flash: undefined })),
      activeModel: ACTIVE, inventoryLoaded: true,
    } as never)
    render(<ModelSelector openUpward />)
    fireEvent.click(trigger())
    expect(rows()).toHaveLength(TOTAL)
    expect(menu().querySelectorAll('.lu-picker-rate-btn')).toHaveLength(0)
  })

  it('says "No credits" for a Flash model on a paid plan, with the daily number the server sent', () => {
    open()
    fireEvent.click(rateButton('Qwen3 32B')!)
    expect(ratePopover()!.textContent).toBe('No credits on your plan, up to 500,000 tokens per day.')
  })

  it('shows the rates of that same model to an account whose plan does not pay', () => {
    signIn(false)
    open()
    fireEvent.click(rateButton('Qwen3 32B')!)
    expect(ratePopover()!.querySelector('[data-rate="input"]')!.textContent).toBe('10,000')
  })

  // HARD RULE (feedback-keine-token-je-geld): credits per token count only.
  it('never names money: no currency in any popover, and none in the source', () => {
    open()
    for (const m of PICKER_FIXTURE) {
      const button = rateButton(m.label)
      if (!button) continue
      fireEvent.click(button)
      const text = ratePopover()!.textContent!
      expect(text, m.label).not.toMatch(/[$€£]|usd|eur|dollar|cent|price|cost/i)
      expect(text, m.label).not.toMatch(/tokens? (per|for|je) (credit|\d)/i)
      fireEvent.click(button)
    }
    const source = readFileSync(resolve(__dirname, '..', 'CloudModelPicker.tsx'), 'utf8')
    expect(source).not.toMatch(/[$€£]\s?\d|CREDIT_USD|usdPer|perDollar|perEuro/)
  })
})

describe('the line under the search', () => {
  it('says what the pick is for while nothing is picked', () => {
    open(null)
    expect(screen.getByTestId('picker-choose-a-model').textContent).toBe('Choose a model to send your message.')
    expect(screen.queryByTestId('picker-send-needs-model')).toBeNull()
  })

  it('is absent once a model is picked', () => {
    open()
    expect(screen.queryByTestId('picker-choose-a-model')).toBeNull()
    expect(menu().querySelectorAll('.lu-picker-note')).toHaveLength(0)
  })

  it('opens by itself on a send without a model and adds, in the same one line, that the message is kept', async () => {
    useModelStore.setState({ models: MODELS, activeModel: null, inventoryLoaded: true } as never)
    const { rerender } = render(<ModelSelector openUpward />)
    const { act } = await import('@testing-library/react')
    act(() => { useUIStore.getState().askForModel() })
    rerender(<ModelSelector openUpward />)
    expect(isOpen()).toBe(true)
    expect(screen.getByTestId('picker-send-needs-model').textContent)
      .toBe('Choose a model to send your message. Your text and attachments are kept.')
    expect(screen.queryByTestId('picker-choose-a-model')).toBeNull()
    expect(menu().querySelectorAll('.lu-picker-note')).toHaveLength(1)
  })

  it('carries a standing model note with its tone and its way out', async () => {
    const { act } = await import('@testing-library/react')
    open()
    act(() => { useLuEngineSwitchStore.getState().announce('The chat switched models.', 'error') })
    const note = screen.getByTestId('picker-engine-note')
    expect(note.textContent).toBe('The chat switched models.')
    expect(note.closest('.lu-picker-note')!.getAttribute('data-tone')).toBe('error')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('picker-engine-note')).toBeNull()
  })
})

describe('Code', () => {
  it('leaves out a hosted model that cannot call tools and says so in the footer', () => {
    open(ACTIVE, { surface: 'code' })
    expect(rows()).toHaveLength(TOTAL - 1)
    expect(labels()).not.toContain('MythoMax L2 13B')
    const hidden = screen.getByTestId('model-picker-hidden-for-code')
    expect(hidden.textContent).toBe('1 hidden, no tool calling')
    expect(hidden.getAttribute('title')).toBe('1 cloud model is hidden here because they cannot call tools. They are still in Chat.')
  })

  it('says nothing of it in Chat', () => {
    open()
    expect(screen.queryByTestId('model-picker-hidden-for-code')).toBeNull()
  })
})

describe('loading and empty', () => {
  it('shows a skeleton and no claim while no list has arrived', () => {
    useModelStore.setState({ models: [], activeModel: null, inventoryLoaded: false } as never)
    render(<ModelSelector openUpward />)
    fireEvent.click(trigger())
    expect(screen.getByRole('status').textContent).toContain('Loading model list')
    expect(menu().textContent).not.toContain('No models available')
  })

  it('says that no model is there once the list arrived empty', () => {
    useModelStore.setState({ models: [], activeModel: null, inventoryLoaded: true } as never)
    render(<ModelSelector openUpward />)
    fireEvent.click(trigger())
    expect(menu().textContent).toContain('No models available')
    expect(count()).toBe('0 cloud models')
  })
})
