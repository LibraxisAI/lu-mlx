/**
 * @vitest-environment jsdom
 *
 * Posten 3, bau/review-lanes.md "Runde 3 der Pruefung": DIE-301-LISTE.md
 * nennt lu-300-desktop's `1f19b7b8` ("fix(chat): dismissing the stale-model
 * chip actually dismisses it") als nirgends sonst vorhanden. Geprueft:
 *
 *   git -C ~/Desktop/LU/lu-300-desktop branch -a --contains 1f19b7b8
 *     -> nur qa/sweep und remotes/origin/qa/sweep, NICHT main/master.
 *   git -C ~/Desktop/LU/lu-300-desktop cat-file -t 1f19b7b8 -> commit
 *     (das Objekt existiert und ist erreichbar, aber nur von einem
 *     Nebenzweig eines ANDEREN Repos als diesem hier).
 *
 * lu-300-desktop und dieses Repo (the web app) sind zwei getrennte Repos ohne
 * gemeinsame Historie, ein `git cherry-pick` laeuft hier ins Leere. Der
 * Quelltext von Header.tsx ist seither auch strukturell auseinandergelaufen
 * (`syncStaleToStore`, `checkModelCapability`-Refresh-Pfad gibt es dort
 * nicht), ein Patch haette nicht angewendet. Der Fund selbst war aber
 * VORHANDEN: derselbe Wettlauf existierte hier unveraendert (die X klickte
 * nur `setStaleError(null)`, der Effekt drei Zeilen darueber baute die
 * Zeile aus `healthStaleModels` in derselben Runde wieder auf), also wurde
 * dieselbe Idee nachgebaut statt gepickt: eine sitzungslokale Liste
 * dismissedStale, die der Effekt respektiert.
 *
 * Lauf: npx vitest run src/components/layout/__tests__/stale-chip-dismiss-sticks.test.tsx
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../DownloadBadge', () => ({ DownloadBadge: () => null }))
vi.mock('../UpdateBadge', () => ({ UpdateBadge: () => null }))
vi.mock('../../cloud/CloudSwitch', () => ({ CloudSwitch: () => null }))
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({
    pullModel: vi.fn().mockResolvedValue(undefined),
    isPullingModel: () => false,
    fetchModels: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../../../api/ollama', () => ({
  loadModel: vi.fn().mockResolvedValue(undefined),
  checkModelCapability: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../../../api/providers', () => ({
  // Selbe Regel wie model-name.ts: kein Praefix heisst Ollama.
  getProviderIdFromModel: (name: string) => (name.includes('::') ? name.split('::')[0] : 'ollama'),
}))

import { Header } from '../Header'
import { useModelStore } from '../../../stores/modelStore'
import { useModelHealthStore } from '../../../stores/modelHealthStore'
import { useUIStore } from '../../../stores/uiStore'

const STALE_MODEL = 'qwen3:8b'

beforeEach(() => {
  useModelStore.setState({ activeModel: STALE_MODEL })
  useModelHealthStore.setState({ staleModels: [STALE_MODEL], lastScanTime: 0, scanning: false, dismissed: false })
  useUIStore.setState({ currentView: 'chat' })
})

afterEach(cleanup)

describe('die stale-Chip-X entfernt den Chip wirklich', () => {
  it('bleibt weg, nachdem der Nutzer sie geklickt hat, statt im selben Zug wiederzukommen', async () => {
    render(createElement(Header))

    expect(await screen.findByText('stale')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))

    // VOR dem Fix baute der Effekt die Zeile im selben Durchlauf wieder auf,
    // weil `healthStaleModels` das Modell weiterhin fuehrt und `staleError`
    // durch den Klick auf `null` gefallen war (isStale && !staleError). Ein
    // `waitFor`, das den Text bestaetigt VERSCHWUNDEN bleibt, faengt genau
    // das ab, ein einfaches "nicht mehr da direkt danach" nicht.
    await waitFor(() => expect(screen.queryByText('stale')).toBeNull())
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('GEGENPROBE: ein ANDERES stale-Modell zeigt seinen eigenen Chip trotzdem', async () => {
    // Die Dismiss-Liste ist pro Modell, nicht app-weit: den Chip fuer B
    // wegzuklicken, darf A nicht mit wegnehmen, wenn der Nutzer spaeter zu A
    // wechselt.
    const OTHER = 'llama3:8b'
    useModelHealthStore.setState({ staleModels: [STALE_MODEL, OTHER] })
    render(createElement(Header))
    await screen.findByText('stale')
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByText('stale')).toBeNull())

    useModelStore.setState({ activeModel: OTHER })
    await screen.findByText('stale')
  })
})
