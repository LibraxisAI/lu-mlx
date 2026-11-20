/**
 * @vitest-environment jsdom
 *
 * 3.0.4 halved the paid-provider send window (lib/send-window.ts). No UI ever
 * wrote codexSendWindowTokens, so a stored 64000 is the old default riding
 * along in the profile and must follow the new one on the next start. Any
 * other stored number was put there on purpose and stays.
 *
 * Run: npx vitest run src/stores/__tests__/send-window-retired-default.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from '../settingsStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'

const KEY = 'chat-settings'

function seed(codexSendWindowTokens: number) {
  window.localStorage.setItem(KEY, JSON.stringify({
    state: {
      settings: { ...DEFAULT_SETTINGS, codexSendWindowTokens },
      personas: [],
      activePersonaId: 'unrestricted',
      _version: 22,
    },
    version: 22,
  }))
}

beforeEach(() => window.localStorage.removeItem(KEY))

describe('the retired 64k send window', () => {
  it('a stored 64000 follows the new 32k default', async () => {
    seed(64000)
    await useSettingsStore.persist.rehydrate()
    expect(useSettingsStore.getState().settings.codexSendWindowTokens).toBe(32768)
  })

  it('a deliberate other value stays', async () => {
    seed(96000)
    await useSettingsStore.persist.rehydrate()
    expect(useSettingsStore.getState().settings.codexSendWindowTokens).toBe(96000)
  })
})
