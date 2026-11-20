/**
 * @vitest-environment jsdom
 *
 * R13D Nebenfund 1 (3.0.1 box-gruen r13d, 2026-09-21): two custom local
 * OpenAI-compatible providers added and removed again can take LU Engine
 * out of the provider list entirely, with no card and no restart bringing
 * it back. Root cause lives in the single-slot memory of
 * `lib/openai-slot-handover.ts` and is not reworked here (owner's
 * instruction: notice only, no rebuild of the slot logic for 3.0.1). This
 * proves the notice: it shows exactly when LU Engine is really gone, the X
 * dismisses it, Restore calls the same path Add Provider, LU Engine uses,
 * and the normal state draws nothing at all.
 *
 * Run: npx vitest run src/components/settings/__tests__/engine-missing-notice.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ProviderConfig, ProviderId } from '../../../api/providers/types'

const checkConnection = vi.fn()
const listModels = vi.fn()

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => false,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/builtin-ensure', () => ({
  readBuiltinSlotStatus: vi.fn(async () => null),
  diagnoseBuiltinEngine: vi.fn(async () => ({ ok: false, reason: '' })),
}))
vi.mock('../../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../../api/providers')>('../../../api/providers')
  return { ...actual, getProvider: () => ({ checkConnection, listModels }) }
})

const { ProviderSettings } = await import('../ProviderConfig')
const { resetEngineNoticeDismissal } = await import('../../../lib/engine-notice-session')
const { useProviderStore } = await import('../../../stores/providerStore')

const aus = (id: ProviderId, name: string, baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id, name, enabled: false, baseUrl, apiKey: '', isLocal: false, ...extra })

function baseline(openai: ProviderConfig, engineOptedOut = false) {
  useProviderStore.setState({
    providers: {
      ollama: aus('ollama', 'Ollama', 'http://localhost:11434'),
      openai,
      anthropic: aus('anthropic', 'Anthropic', 'https://api.anthropic.com'),
      'lu-cloud': aus('lu-cloud', 'LU Cloud', 'https://lu-labs.ai/api/inference/v1'),
    },
    // Opus review: a stale opt-out from an earlier test in this file (or a
    // stale value the persisted singleton store carried in from elsewhere)
    // must not leak between cases, the same reason `providers` is reset here.
    engineOptedOut,
  })
}

beforeEach(() => {
  checkConnection.mockReset()
  checkConnection.mockResolvedValue(true)
  listModels.mockReset()
  listModels.mockResolvedValue([])
  // Die Wegdrueckung lebt seit dem Umbau in einer Modulvariablen, die Settings
  // und Modellmenue teilen (lib/engine-notice-session.ts). Ohne diesen Reset
  // wuerde das X aus einem Fall den naechsten Fall stumm schalten.
  resetEngineNoticeDismissal()
})
afterEach(cleanup)

async function open() {
  const utils = render(createElement(ProviderSettings))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return utils
}

describe('the LU Engine missing notice in Settings, AI Backends, Providers', () => {
  it('is drawn when LU Engine occupies the slot and nothing is on standby: NOTHING', async () => {
    baseline({ id: 'openai', name: 'LU Engine', enabled: true, baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true })
    await open()
    expect(screen.queryByTestId('engine-missing-notice')).toBeNull()
  })

  it('is drawn when LU Engine is entirely gone: no occupant, no standby card', async () => {
    baseline({ id: 'openai', name: 'Jan', enabled: true, baseUrl: 'http://localhost:1337/v1', apiKey: '', isLocal: true, managed: false })
    await open()
    const notice = screen.getByTestId('engine-missing-notice')
    expect(notice.textContent).toContain('LU Engine is missing from your providers')
    // 3.0.4 Gegenprobe 02.10.: the line promised a fix "in the next update"
    // since 21.09. and no update carried it. It promises nothing now.
    expect(notice.textContent).not.toMatch(/next update/i)
    // Opus review, Blocker 2: the notice must never claim local chat is
    // broken, since a working local backend can be sitting right there in
    // the slot Jan occupies here.
    expect(notice.textContent).not.toContain('Local chat will not answer')
  })

  // Opus review, Blocker 1: the exact same slot shape (managed: false, no
  // displaced) is what a customer leaves behind by picking Ollama or LM
  // Studio on purpose in onboarding, the startup selector, or Start LM
  // Studio Server. Without engineOptedOut this used to be a false positive
  // shown to every one of those customers, at every single launch.
  it('NEGATIVE CONTROL: is NOT drawn when the customer opted for a different backend on purpose (engineOptedOut)', async () => {
    baseline({ id: 'openai', name: 'Ollama-adjacent slot', enabled: false, baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: false }, true)
    await open()
    expect(screen.queryByTestId('engine-missing-notice')).toBeNull()
  })

  it('is NOT drawn when LU Engine is only parked on standby: it has a way back already', async () => {
    baseline({
      id: 'openai', name: 'Jan', enabled: true, baseUrl: 'http://localhost:1337/v1', apiKey: '', isLocal: true, managed: false,
      displaced: { name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true },
    })
    await open()
    expect(screen.queryByTestId('engine-missing-notice')).toBeNull()
  })

  it('the X dismisses it for the running session', async () => {
    baseline({ id: 'openai', name: 'Jan', enabled: true, baseUrl: 'http://localhost:1337/v1', apiKey: '', isLocal: true, managed: false })
    await open()
    expect(screen.getByTestId('engine-missing-notice')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByTestId('engine-missing-notice')).toBeNull()
  })

  it('Restore LU Engine hands the slot back through the SAME path (selectPreset) the Add Provider dropdown uses, and the notice clears', async () => {
    baseline({ id: 'openai', name: 'Jan', enabled: true, baseUrl: 'http://localhost:1337/v1', apiKey: '', isLocal: true, managed: false })
    await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore LU Engine' })) })
    expect(screen.queryByTestId('engine-missing-notice')).toBeNull()
    const openai = useProviderStore.getState().providers.openai
    expect(openai.managed).toBe(true)
    expect(openai.name).toBe('LU Engine')
    expect(openai.baseUrl).toBe('http://127.0.0.1:8127/v1')
    // The backend that was occupying the slot is remembered on standby, the
    // same swap every other takeover does, Jan is not just thrown away.
    expect(openai.displaced?.name).toBe('Jan')
  })

  // Opus review, Blocker 3: the button called applyPreset directly, which
  // skips selectPreset's key-loss warning. A customer whose own provider
  // carries an API key that cannot be parked in the OS keychain would lose
  // it on the next restart with nobody asking first. Proven here by reading
  // the wiring: the Restore button must go through the SAME function name
  // the "Add Provider, LU Engine" dropdown entry uses, not a second path
  // that happens to look similar.
  it('the wiring goes through selectPreset, not a second path that skips its key-loss check', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pane = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../ProviderConfig.tsx'), 'utf8')
    const bannerStart = pane.indexOf('data-testid="engine-missing-notice"')
    const bannerEnd = pane.indexOf('{/* Providers List')
    expect(bannerStart).toBeGreaterThan(-1)
    expect(bannerEnd).toBeGreaterThan(bannerStart)
    const banner = pane.slice(bannerStart, bannerEnd)
    expect(banner).toMatch(/onClick=\{\(\) => selectPreset\(PROVIDER_PRESETS\.find\(p => p\.id === 'builtin'\)!\)\}/)
    expect(banner).not.toContain('applyPreset(')
  })

  /**
   * Windows-Bau t14, Bild 38-lmstudio-added.png: die Zeile war knallrot, mit
   * rotem Dreieck, rotem X und einem eigenen Kaestchen um "Restore LU Engine".
   * Der Eigner will "unauffaellig, aber so, dass man es sieht", also derselbe
   * ruhige Ton wie die Zeile oben im Modellmenue des Chats.
   */
  it('traegt den ruhigen Ton, nicht Rot, und den Akzent nur am Textknopf', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pane = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../ProviderConfig.tsx'), 'utf8')
    const banner = pane.slice(
      pane.indexOf('data-testid="engine-missing-notice"'),
      pane.indexOf('{/* Providers List'),
    )
    expect(banner).toContain('HINWEIS_TEXT.ruhig')
    expect(banner).not.toContain('HINWEIS_TEXT.fehler')
    expect(banner).not.toContain('text-red-')
    // Kein Kasten mehr um den Restore-Knopf, er ist ein Textknopf im Akzent.
    expect(banner).toContain('text-lu-accent')
    expect(banner).not.toContain('lu-control')
    // NEGATIVKONTROLLE mit Zahl: der Ausschnitt ist wirklich die Zeile und
    // nicht ein leerer String, sonst waere jede Aussage oben wertlos.
    expect(banner.length).toBeGreaterThan(200)
    expect((banner.match(/Restore LU Engine/g) ?? []).length).toBe(1)
  })

  it('und die Zeile im Modellmenue sieht genauso aus: gleicher Ton, gleicher Akzent', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const picker = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../models/ModelSelector.tsx'), 'utf8')
    const zeile = picker.slice(
      picker.indexOf('data-testid="picker-engine-missing"'),
      picker.indexOf('Bug Q v2.4.7'),
    )
    expect(zeile).toContain('HINWEIS_TEXT.ruhig')
    expect(zeile).toContain('text-lu-accent')
    expect(zeile).not.toContain('text-red-')
    expect(zeile.length).toBeGreaterThan(200)
  })

  // NEGATIVE CONTROL: two providers on the screen, one occupant and one
  // standby card, and neither one is LU Engine, is the one state where the
  // notice really is owed.
  it('NEGATIVE CONTROL: two custom providers on screen, LU Engine in neither, the notice shows', async () => {
    baseline({
      id: 'openai', name: 'LM Studio', enabled: true, baseUrl: 'http://localhost:1234/v1', apiKey: '', isLocal: true, managed: false,
      displaced: { name: 'Jan', baseUrl: 'http://localhost:1337/v1', isLocal: true, managed: false },
    })
    await open()
    expect(screen.getByTestId('engine-missing-notice')).toBeTruthy()
  })
})
