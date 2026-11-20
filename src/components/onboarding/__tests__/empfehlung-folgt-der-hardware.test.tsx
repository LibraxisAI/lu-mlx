/**
 * @vitest-environment jsdom
 *
 * Opus-Runde 2, Blocker 3 (review-onboard9b.md): die reine Funktion
 * `recommendedOnboardingModelName` war gut geprueft, aber kein Test bemerkte,
 * ob `ModelsStep.tsx` sie ueberhaupt benutzt. Die Gegenprobe im Bericht drehte
 * `{model.name === recommendedModelName && showRecommendedBadge && (` von Hand
 * auf die alte Form `{model.recommended && showRecommendedBadge && (` zurueck
 * und liess damit 16 von 16 Testdateien unveraendert gruen. Dieser Test
 * rendert den Schritt wirklich und liest, an welcher Kachel "Recommended"
 * steht. Die alte Form wuerde ihn bei 12 GB VRAM falsch am 7B-Starter
 * bestehen lassen statt am 9B-Modell.
 *
 * Lauf: npx vitest run src/components/onboarding/__tests__/empfehlung-folgt-der-hardware.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const getMaxVramGb = vi.fn(async () => 0)
const getSystemVRAM = vi.fn(async () => null)

vi.mock('../../../lib/hardware', () => ({ getMaxVramGb: () => getMaxVramGb() }))
vi.mock('../../../api/comfyui', () => ({ getSystemVRAM: () => getSystemVRAM() }))
vi.mock('../../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  pullModelTauri: vi.fn(),
  checkConnection: vi.fn(async () => false),
}))
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => false,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/discover', () => ({
  detectProviderModelPath: vi.fn(async () => ''),
  startModelDownloadToPath: vi.fn(),
  luEngineDownloadDir: vi.fn(async () => ''),
}))
vi.mock('../../../api/engine', () => ({ activateBuiltinModel: vi.fn() }))

const { useProviderStore } = await import('../../../stores/providerStore')
const { useModelStore } = await import('../../../stores/modelStore')
const { ModelsStep } = await import('../ModelsStep')
const { onboardingSkin } = await import('../onboarding-skin')

const LEERE_FLOTTE = {
  ollama: { phase: 'idle' }, lmstudio: { phase: 'idle' },
  comfyInstall: { phase: 'idle' }, pythonInstall: { phase: 'idle' },
  ollamaDo: () => {}, lmstudioDo: () => {}, comfyInstallDo: () => {}, pythonInstallDo: () => {},
  secondsOf: () => 0,
}
const LEERER_SCAN = {
  detectedBackends: [], detecting: false, selectedBackend: 'builtin',
  setSelectedBackend: () => {}, lmstudioOfflineDetected: false, lmstudioModelCount: 0,
  runDetection: async () => {}, stopDetection: () => {},
}

function zeichnen() {
  return render(createElement(ModelsStep, {
    skin: onboardingSkin(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scan: LEERER_SCAN as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fleet: LEERE_FLOTTE as any,
    step: 'models' as const,
    setStep: () => {},
    pulledModels: [],
    setPulledModels: () => {},
  }))
}

/** Die Kachel, in der ein Modellname steht (Karte samt Abzeichen). */
function kachelVon(label: string): HTMLElement {
  const knoten = screen.getByText(label)
  const button = knoten.closest('button')
  expect(button, `keine Kachel fuer "${label}" gefunden`).not.toBeNull()
  return button as HTMLElement
}

beforeEach(() => {
  useProviderStore.getState().setProviderConfig('ollama', { enabled: false, disabledByUser: true })
  useModelStore.setState({ activeModel: null })
})
afterEach(() => {
  cleanup()
  getMaxVramGb.mockReset()
  getSystemVRAM.mockReset()
  getMaxVramGb.mockImplementation(async () => 0)
  getSystemVRAM.mockImplementation(async () => null)
})

describe('das Abzeichen folgt der Hardware, nicht dem statischen Feld', () => {
  it('12 GB (eine RTX 3060, die Hardware aus dem Auftrag): das Abzeichen sitzt auf Qwen 3.5 9B', async () => {
    getMaxVramGb.mockImplementation(async () => 12)
    zeichnen()
    await waitFor(() => {
      expect(kachelVon('Qwen 3.5 9B Abliterated').textContent).toContain('Recommended')
    })
    expect(kachelVon('Qwen 2.5 7B Abliterated (Starter)').textContent).not.toContain('Recommended')
    // Genau eins, nicht zwei: keine zweite Kachel wirbt gleichzeitig.
    expect(screen.getAllByText('Recommended', { exact: true })).toHaveLength(1)
  })

  it('0 GB / unbekannte Hardware: das Abzeichen bleibt beim 7B-Starter', async () => {
    getMaxVramGb.mockImplementation(async () => 0)
    getSystemVRAM.mockImplementation(async () => null)
    zeichnen()
    await waitFor(() => {
      expect(kachelVon('Qwen 2.5 7B Abliterated (Starter)').textContent).toContain('Recommended')
    })
    expect(kachelVon('Qwen 3.5 9B Abliterated').textContent).not.toContain('Recommended')
    expect(screen.getAllByText('Recommended', { exact: true })).toHaveLength(1)
  })

  // Negativkontrolle mit Zahlen: 6 GB traegt den 7B-Starter (Bedarf 6), aber
  // nicht das gemessene 9B (Bedarf 6,1). Ohne diese Zeile koennte eine
  // Verdrahtung, die ab v>0 immer 9B zeigt, den ersten Fall oben ebenfalls
  // bestehen.
  it('NEGATIVKONTROLLE: 6 GB traegt den 7B-Starter, aber nicht das gemessene 9B', async () => {
    getMaxVramGb.mockImplementation(async () => 6)
    zeichnen()
    await waitFor(() => {
      expect(kachelVon('Qwen 2.5 7B Abliterated (Starter)').textContent).toContain('Recommended')
    })
    expect(kachelVon('Qwen 3.5 9B Abliterated').textContent).not.toContain('Recommended')
  })
})
