/**
 * A Mac names its shortcuts with the Command key, and the app listens there.
 *
 * Fehlerkontrolle Mac 2, Fund 8: the help dialog and the command palette
 * showed "Ctrl+K" on a Mac. Ctrl+K does nothing there while a text field has
 * the focus (`shortcutOwner` hands Ctrl without Cmd back to the field, they
 * are the system's Emacs bindings), and Cmd+K, which works, stood nowhere.
 *
 * The labels are rewritten at ONE place, `platformKeys`, and both readers go
 * through it. On Windows and Linux the labels are the ones in `SHORTCUTS`,
 * character for character.
 *
 * Negative control: with `shortcutKeys` returning `SHORTCUTS[...].keys`
 * untouched and the dialog printing `s.keys`, the Mac cases and the two
 * source checks are red.
 *
 * Run: npx vitest run src/hooks/__tests__/shortcut-labels-mac.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SHORTCUTS,
  platformKeys,
  shortcutCommandFor,
  shortcutKeys,
  type ShortcutId,
} from '../useKeyboardShortcuts'

const MAC = true
const PC = false

describe('the label of a shortcut', () => {
  it('on a Mac it is written with the Mac symbols, modifiers in Apple order and no plus', () => {
    expect(platformKeys('Ctrl+K', MAC)).toBe('⌘K')
    expect(platformKeys('Ctrl+/', MAC)).toBe('⌘/')
    expect(platformKeys('Ctrl+Shift+D', MAC)).toBe('⇧⌘D')
    expect(platformKeys('Ctrl+Alt+P', MAC)).toBe('⌥⌘P')
    expect(platformKeys('Escape', MAC)).toBe('Escape')
  })

  it('on a Mac no entry of the list still says Ctrl, Alt or Shift', () => {
    for (const s of SHORTCUTS) {
      expect(platformKeys(s.keys, MAC), s.keys).not.toMatch(/Ctrl|Alt|Shift|\+/)
    }
  })

  it('WINDOWS CONTROL: every label is the one in the list, unchanged', () => {
    for (const s of SHORTCUTS) expect(platformKeys(s.keys, PC)).toBe(s.keys)
    expect(SHORTCUTS.map((s) => s.keys)).toEqual([
      'Ctrl+K', 'Ctrl+N', 'Ctrl+L', 'Ctrl+E', 'Ctrl+Shift+D', 'Ctrl+/', 'Escape',
    ])
  })

  it('the command palette reads the same label: shortcutKeys is already in platform spelling', () => {
    expect(shortcutKeys('command-palette', MAC)).toBe('⌘K')
    expect(shortcutKeys('toggle-theme', MAC)).toBe('⇧⌘D')
    expect(shortcutKeys('command-palette', PC)).toBe('Ctrl+K')
    expect(shortcutKeys('toggle-theme', PC)).toBe('Ctrl+Shift+D')
  })
})

describe('the shortcut itself', () => {
  /** The key press each label describes. */
  const PRESS: Record<ShortcutId, { key: string; shiftKey: boolean }> = {
    'command-palette': { key: 'k', shiftKey: false },
    'new-conversation': { key: 'n', shiftKey: false },
    'focus-chat-input': { key: 'l', shiftKey: false },
    'export-chat': { key: 'e', shiftKey: false },
    'toggle-theme': { key: 'D', shiftKey: true },
    'show-shortcuts': { key: '/', shiftKey: false },
  }
  const ids = SHORTCUTS.map((s) => s.id).filter((id): id is ShortcutId => id !== null)

  it.each(ids)('on a Mac %s answers to Command, inside the chat field too', (id) => {
    const cmd = { ...PRESS[id], metaKey: true, ctrlKey: false }
    expect(shortcutCommandFor(cmd, true, MAC)).toBe(id)
    expect(shortcutCommandFor(cmd, false, MAC)).toBe(id)
  })

  it.each(ids)('WINDOWS CONTROL: %s answers to Ctrl, inside the chat field too', (id) => {
    const ctrl = { ...PRESS[id], metaKey: false, ctrlKey: true }
    expect(shortcutCommandFor(ctrl, true, PC)).toBe(id)
    expect(shortcutCommandFor(ctrl, false, PC)).toBe(id)
  })

  it('on a Mac, Ctrl inside a text field stays with the field, which is why the label must not say Ctrl', () => {
    expect(shortcutCommandFor({ key: 'k', shiftKey: false, metaKey: false, ctrlKey: true }, true, MAC)).toBeNull()
  })
})

describe('the two places that show a shortcut', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('the help dialog prints the platform label, not the raw list entry', () => {
    const src = read('components/layout/ShortcutsModal.tsx')
    expect(src).toContain('{platformKeys(s.keys)}')
    // `key={s.keys}` is React's list key and may stay; a line of its own is the printed label.
    expect(src).not.toMatch(/^\s*\{s\.keys\}\s*$/m)
  })

  it('the command palette takes its labels from shortcutKeys', () => {
    expect(read('components/ui/CommandPalette.tsx')).toContain('keysFor: shortcutKeys')
  })
})
