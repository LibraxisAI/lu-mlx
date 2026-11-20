// @vitest-environment jsdom
/**
 * Computer control stays in the app on a Mac, and says there, in the open,
 * that it is not tested through: at the switch in Settings and in the card
 * that asks for the first use in a chat. Windows and Linux read what they
 * read before.
 *
 * Run: npx vitest run src/components/computer/__tests__/computer-control-says-it-is-untested-on-a-mac.test.tsx
 */
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const host = vi.hoisted(() => ({ mac: false }))
vi.mock('../../../api/computer-chat', () => ({ answerComputerChatAsk: () => {} }))
vi.mock('../../../api/backend', async (original) => ({
  ...(await original<typeof import('../../../api/backend')>()),
  isMacOS: () => host.mac,
}))

import { ComputerChatPermission } from '../ComputerChatPermission'
import { COMPUTER_CONTROL_MAC_NOTE, computerControlMacNote } from '../../../lib/beta'

const ask = { id: 'computer-chat-ask-1', chatKey: 'chat-a', conversationId: 'chat-a', voice: false }
const note = () => document.querySelector('[data-testid="computer-chat-mac-note"]')

afterEach(() => {
  cleanup()
  host.mac = false
})

describe('computer control on a Mac', () => {
  it('has a sentence of its own on a Mac and none elsewhere', () => {
    expect(computerControlMacNote(true)).toBe(COMPUTER_CONTROL_MAC_NOTE)
    expect(computerControlMacNote(false)).toBeNull()
    expect(COMPUTER_CONTROL_MAC_NOTE).toContain('not fully tested yet')
    expect(COMPUTER_CONTROL_MAC_NOTE).not.toMatch(/[–—]/)
  })

  it('says it in the card of the first use, with Allow still there', () => {
    host.mac = true
    render(createElement(ComputerChatPermission, { ask }))
    expect(note()?.textContent).toBe(COMPUTER_CONTROL_MAC_NOTE)
    expect(document.querySelector('[data-testid="computer-chat-allow"]')).not.toBeNull()
  })

  it('leaves the card on Windows and Linux as it was', () => {
    render(createElement(ComputerChatPermission, { ask }))
    expect(note()).toBeNull()
  })

  it('says it under the switch in Settings, and does not hide or lock the switch', () => {
    const settings = readFileSync(resolve(__dirname, '../../settings/PermissionSettings.tsx'), 'utf8')
    expect(settings).toContain('data-testid="computer-control-mac-note"')
    expect(settings).toContain('computerControlMacNote(isMacOS())')
    expect(settings).toContain('<ToggleSwitch enabled={computerEnabled} onChange={setComputerEnabled} ariaLabel="Computer control" />')
  })
})
