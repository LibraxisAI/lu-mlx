// @vitest-environment jsdom
/**
 * Der Kontextwaehler eines EIGENEN OpenAI-kompatiblen Servers bietet nichts an,
 * was dieser Server nicht kann.
 *
 * T4 auf der Box, 11.09.2026: ein llama-server auf `--ctx-size 16384` bekam die
 * Liste `Auto · 40K`, `4K`, `8K`, `16K`, `32K`, `40K · max`. Die oberen beiden
 * Eintraege sind Behauptungen ueber einen fremden Server: LU kann sein `-c`
 * nicht setzen, anders als bei Ollama, LM Studio und dem eigenen Motor, wo eine
 * Wahl das Modell wirklich neu laedt. Wer sie anklickt, bekommt ein
 * `max_tokens` ueber dem ganzen Fenster des Servers.
 *
 * Gemessen wird hier der Waehler selbst, nicht die Kaskade dahinter (die liegt
 * in api/providers/__tests__/openai-context-source.test.ts).
 *
 * Run: npx vitest run src/components/chat/__tests__/kontextliste-endet-am-fenster.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ActiveContext } from '../../../hooks/useActiveContextWindow'

/** Was der Haken der Kaskade liefert, je Test gesetzt. */
let ctx: ActiveContext

vi.mock('../../../hooks/useActiveContextWindow', () => ({
  useActiveContextWindow: () => ctx,
  useActiveWindowUse: () => 'chat',
}))

import { ContextDropdown } from '../ContextDropdown'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'

const WINDOW_KEY = 'http://127.0.0.1:8131|my-model'

/** Ein eigener Endpunkt, dessen laufendes Fenster der Server genannt hat. */
function vomServer(overrides: Partial<ActiveContext> = {}): ActiveContext {
  return {
    provider: 'custom',
    contextWindow: 16384,
    modelMax: 16384,
    sendWindow: 16384,
    isTrue: true,
    adjustable: true,
    source: 'probe',
    windowKey: WINDOW_KEY,
    ...overrides,
  }
}

const zeilen = () =>
  screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '')

beforeEach(() => {
  cleanup()
  ctx = vomServer()
  useModelStore.setState({ activeModel: 'my-model' })
  useSettingsStore.getState().updateSettings({ contextWindowByModel: {} })
})

describe('Kontextwaehler am eigenen Endpunkt', () => {
  it('endet am laufenden Fenster und nennt es max', () => {
    render(<ContextDropdown />)
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))

    expect(zeilen()).toContain('16K · max')
    expect(zeilen()).toContain('8K')
    // Nichts darueber: dieser Server laeuft mit 16384 und wird davon nicht
    // groesser.
    expect(screen.queryByRole('button', { name: /^32K/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^40K/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^64K/ })).toBeNull()
  })

  it('ohne laufendes Fenster reicht die Liste bis zur trainierten Decke', () => {
    ctx = vomServer({ contextWindow: 40960, modelMax: 40960, source: 'trained', isTrue: false })
    render(<ContextDropdown />)
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))

    expect(zeilen()).toContain('40K · max')
    expect(zeilen()).toContain('32K')
    expect(screen.getByText(/training limit/)).toBeTruthy()
  })

  it('sagt in einer Zeile, warum die gespeicherte Wahl nicht gilt', () => {
    useSettingsStore.getState().updateSettings({ contextWindowByModel: { [WINDOW_KEY]: 40960 } })
    ctx = vomServer({ source: 'user', clampedFrom: 40960 })
    render(<ContextDropdown />)
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))

    expect(screen.getByText(/Your saved 40K is more than this server runs, so 16K is used/))
      .toBeTruthy()
    // Der Haken sitzt auf dem, was gilt, und nicht auf einer Zahl, die es in
    // der Liste gar nicht mehr gibt.
    const max = screen.getByRole('button', { name: /^16K · max/ })
    expect(max.querySelector('svg')).toBeTruthy()
  })
})
