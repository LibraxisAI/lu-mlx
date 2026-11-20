// @vitest-environment jsdom
/**
 * The Create row in the Plugins menu (Create in chat, desktop, Cloud mode).
 *
 * Who sees it and whether it can be switched is the server's answer: the
 * account release from /api/me, the model release and the window from the
 * model list. The menu holds no list of its own. Nothing of it stands in or
 * above the prompt field: the reason for a greyed switch is a line in the
 * menu.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-create-switch-follows-the-server.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PluginsDropdown } from '../PluginsDropdown'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { BUILT_IN_PERSONAS, DEFAULT_SETTINGS } from '../../../lib/constants'
import { clearCreateChatRelease, noteCreateChatRelease } from '../../../lib/create/chat-release'
import { CREATE_MODEL_REASON } from '../../../lib/create/chat-switch'
import type { AIModel } from '../../../types/models'

const RELEASED = 'lu-cloud::released'
const PLAIN = 'lu-cloud::plain'
const SMALL = 'lu-cloud::small'
const SECOND = 'lu-cloud::second'

const row = (name: string, extra: Partial<AIModel> = {}): AIModel =>
  ({ name, type: 'text', contextLength: 128_000, supportsTools: true, ...extra } as AIModel)

function stage(opts: { mode?: 'cloud' | 'local'; released?: boolean | null; model?: string | null; createEnabled?: boolean }) {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, appMode: opts.mode ?? 'cloud', ...(opts.createEnabled === undefined ? {} : { createEnabled: opts.createEnabled }) },
    personas: [...BUILT_IN_PERSONAS],
  })
  if (opts.released === null || opts.released === undefined) clearCreateChatRelease()
  else noteCreateChatRelease({ features: { createChat: opts.released } })
  useModelStore.setState({ activeModel: opts.model === undefined ? RELEASED : opts.model })
}

let convId = ''
beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useModelStore.setState({
    models: [
      row(RELEASED, { createInChat: true }),
      row(SECOND, { createInChat: true }),
      row(PLAIN),
      row(SMALL, { createInChat: true, contextLength: 8_000 }),
    ],
    activeModel: RELEASED,
  })
  convId = useChatStore.getState().createConversation(RELEASED, '')
  useChatStore.getState().setActiveConversation(convId)
})
afterEach(() => { cleanup(); clearCreateChatRelease() })

function openMenu(iconOnly = false) {
  render(<PluginsDropdown openUpward iconOnly={iconOnly} />)
  fireEvent.click(screen.getByRole('button', { name: /Plugins/ }))
}
const theSwitch = () => screen.queryByTestId('plugins-create-switch') as HTMLButtonElement | null
const reason = () => screen.queryByTestId('plugins-create-reason')?.textContent ?? null

describe('who gets the row at all', () => {
  it('a released account in Cloud mode', () => {
    stage({ released: true })
    openMenu()
    expect(theSwitch()).not.toBeNull()
  })

  it('nobody before the server has answered, and nobody it says no to', () => {
    for (const released of [null, false] as const) {
      stage({ released })
      openMenu()
      expect(theSwitch(), String(released)).toBeNull()
      expect(screen.queryByText('Create')).toBeNull()
      cleanup()
    }
  })

  it('nobody in Local mode, released or not, and a stored "on" changes nothing', () => {
    stage({ mode: 'local', released: true, createEnabled: true })
    openMenu()
    expect(theSwitch()).toBeNull()
    expect(screen.queryByTestId('plugins-dot-create')).toBeNull()
  })

  it('not the Code header', () => {
    stage({ released: true })
    openMenu(true)
    expect(theSwitch()).toBeNull()
  })
})

describe('a model the switch works with', () => {
  it('starts off, switches on with one click and remembers it', () => {
    stage({ released: true })
    openMenu()
    expect(theSwitch()!.disabled).toBe(false)
    expect(theSwitch()!.getAttribute('aria-pressed')).toBe('false')
    expect(reason()).toBeNull()
    fireEvent.click(theSwitch()!)
    expect(useSettingsStore.getState().settings.createEnabled).toBe(true)
    expect(theSwitch()!.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('plugins-dot-create')).toBeTruthy()
    fireEvent.click(theSwitch()!)
    expect(useSettingsStore.getState().settings.createEnabled).toBe(false)
  })
})

describe('greyed, with one short English line in the menu', () => {
  it('a model the server does not release', () => {
    stage({ released: true, model: PLAIN, createEnabled: true })
    openMenu()
    expect(theSwitch()!.disabled).toBe(true)
    // Stored on, shown off: the tools do not go along with this model.
    expect(theSwitch()!.getAttribute('aria-pressed')).toBe('false')
    expect(reason()).toBe(CREATE_MODEL_REASON)
    expect(screen.queryByTestId('plugins-dot-create')).toBeNull()
    fireEvent.click(theSwitch()!)
    expect(useSettingsStore.getState().settings.createEnabled).toBe(true)
  })

  it('a window that does not carry the tools', () => {
    stage({ released: true, model: SMALL })
    openMenu()
    expect(theSwitch()!.disabled).toBe(true)
    expect(reason()).toMatch(/too small a context window \(8k\) for Create/)
  })

  it('no model picked', () => {
    stage({ released: true, model: null })
    openMenu()
    expect(theSwitch()!.disabled).toBe(true)
    expect(reason()).toBe('Pick a model first.')
  })

  it('a group chat', () => {
    stage({ released: true, createEnabled: true })
    useChatStore.getState().setGroupModels(convId, [RELEASED, SECOND])
    openMenu()
    expect(theSwitch()!.disabled).toBe(true)
    expect(reason()).toBe('Not available in a group chat.')
  })

  it('back to a released model: the stored "on" counts again', () => {
    stage({ released: true, model: PLAIN, createEnabled: true })
    openMenu()
    expect(theSwitch()!.getAttribute('aria-pressed')).toBe('false')
    cleanup()
    useModelStore.setState({ activeModel: RELEASED })
    openMenu()
    expect(theSwitch()!.disabled).toBe(false)
    expect(theSwitch()!.getAttribute('aria-pressed')).toBe('true')
  })
})
