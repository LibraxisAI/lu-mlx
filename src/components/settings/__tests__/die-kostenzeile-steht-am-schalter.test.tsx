// @vitest-environment jsdom
/**
 * R5-41: die Kostenzeile stand hinter dem falschen Zweig.
 *
 * Der Satz ueber den stillen zweiten Modellaufruf hing in Settings > AI
 * Backends, hinter `needsKey && autoExtractEnabled`. `providerSlotView` setzt
 * fuer `lu-cloud` ausdruecklich `needsKey: false`, also las genau der Kunde die
 * Zeile nie, dem der Aufruf wirklich berechnet wird. Und unter dem Schalter
 * selbst stand nur der Halbsatz "(extra inference)".
 *
 * Web gilt: die Zeile gehoert neben den Schalter, den sie beschreibt, in
 * ruhigem Grau. Der Web-Waechter dazu ist
 * the web app; hier
 * steht er gespiegelt, dazu die drei Wortlaute an der neuen Stelle.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/die-kostenzeile-steht-am-schalter.test.tsx
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'

vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => null),
  isTauri: () => false,
  isMacOS: () => false,
  openExternal: vi.fn(),
}))

import { MemorySettings, EXTRAKTIONSKOSTEN, extraktionskostenFuer } from '../MemorySettings'
import { useMemoryStore } from '../../../stores/memoryStore'
import { useModelStore } from '../../../stores/modelStore'
import { useProviderStore } from '../../../stores/providerStore'

const lies = (datei: string) => readFileSync(resolve(__dirname, '..', datei), 'utf8')
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

function zeige(activeModel: string | null, an = true) {
  useModelStore.setState({ activeModel })
  useMemoryStore.setState({
    settings: { ...useMemoryStore.getState().settings, autoExtractEnabled: an },
  })
  render(<MemorySettings />)
}

beforeEach(() => {
  cleanup()
  useMemoryStore.setState({ entries: [], memoryCollectionRevision: 0 })
})
afterEach(() => { cleanup() })

describe('R5-41: die Kostenzeile steht am Schalter', () => {
  it('laesst keine zweite, unerreichbare Kopie in AI Backends zurueck', () => {
    // Wortgleich mit dem Waechter im Web. Zwei Kostenzeilen driften
    // auseinander, und die alte nannte "every 3rd turn" fuer einen Weg, den
    // sie gar nicht abdeckte.
    const provider = lies('ProviderConfig.tsx')
    expect(provider).not.toContain('Memory auto-extraction runs a secondary inference')
    expect(provider).not.toContain('autoExtractEnabled')
  })

  it('nennt bei LU Cloud das Guthaben und das billigste Modell', () => {
    zeige('lu-cloud::deepseek-v4.1-flash')
    expect(text()).toContain(EXTRAKTIONSKOSTEN.cloud)
  })

  it('nennt bei einem eigenen Schluessel die Rechnung des Anbieters', () => {
    useProviderStore.setState((s) => ({
      providers: { ...s.providers, anthropic: { ...s.providers.anthropic, isLocal: false } },
    }))
    zeige('anthropic::claude-sonnet-4-20250514')
    expect(text()).toContain(EXTRAKTIONSKOSTEN.eigenerSchluessel)
  })

  it('und behauptet auf der eigenen Maschine keine Rechnung', () => {
    // Der Fall, den das Web nicht hat. Eine erfundene Rechnung waere derselbe
    // Fehler in die andere Richtung.
    useProviderStore.setState((s) => ({
      providers: { ...s.providers, ollama: { ...s.providers.ollama, isLocal: true } },
    }))
    zeige('qwen3.8:latest')
    expect(text()).toContain(EXTRAKTIONSKOSTEN.lokal)
    expect(text()).not.toContain('API costs')
  })

  it('steht nur da, solange der Schalter an ist', () => {
    // Negativkontrolle: aus heisst aus, und zwar fuer alle drei Wortlaute.
    zeige('lu-cloud::deepseek-v4.1-flash', false)
    for (const satz of Object.values(EXTRAKTIONSKOSTEN)) expect(text()).not.toContain(satz)
    // Positivkontrolle: der Schalter selbst ist trotzdem da.
    expect(text()).toContain('Auto-extract memories')
  })

  it('waehlt den Satz am Anbieter des aktiven Modells, nicht am Schluesselzweig', () => {
    const lokal = (id: string) => id === 'ollama' || id === 'openai'
    expect(extraktionskostenFuer('lu-cloud::x', lokal)).toBe(EXTRAKTIONSKOSTEN.cloud)
    expect(extraktionskostenFuer('anthropic::x', lokal)).toBe(EXTRAKTIONSKOSTEN.eigenerSchluessel)
    expect(extraktionskostenFuer('qwen3.8:latest', lokal)).toBe(EXTRAKTIONSKOSTEN.lokal)
    expect(extraktionskostenFuer(null, lokal)).toBeNull()
  })
})
