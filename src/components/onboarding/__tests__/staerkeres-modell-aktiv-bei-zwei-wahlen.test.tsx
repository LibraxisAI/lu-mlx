/**
 * @vitest-environment jsdom
 *
 * Opus-Runde 2, Auflage (review-onboard9b.md): mit zwei gewaehlten
 * Onboarding-Modellen lief `handleDownloadSelected` die Auswahl in
 * Klickreihenfolge durch und rief `activateBuiltinModel` fuer jeden Eintrag,
 * also blieb das ZULETZT geklickte aktiv, nicht das staerkere. Mit einem
 * einzigen Eintrag (vor diesem Auftrag) konnte das nie auffallen.
 *
 * Dieser Test klickt bewusst zuerst das staerkere Modell (Qwen 3.5 9B), dann
 * das schwaechere (Qwen 2.5 7B), damit die alte Reihenfolge-Regel das
 * schwaechere aktiv liesse. Nach dem Lauf muss trotzdem das staerkere aktiv
 * sein.
 *
 * Lauf: npx vitest run src/components/onboarding/__tests__/staerkeres-modell-aktiv-bei-zwei-wahlen.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { bundledPickerIdForFile } from '../../../lib/bundled-download-activation'
import { builtinModelNameFromPath } from '../../../lib/builtin-model-identity'
import { ONBOARDING_MODELS } from '../../../lib/constants'

const activateBuiltinModel = vi.fn(async (_name: string) => true)
const startModelDownloadToPath = vi.fn(async (_url: string, _dir: string, _filename: string, _bytes?: number, _sha?: string) => {})
const awaitDownloadComplete = vi.fn(async (_filename: string) => {})

vi.mock('../../../lib/hardware', () => ({ getMaxVramGb: vi.fn(async () => 0) }))
vi.mock('../../../api/comfyui', () => ({ getSystemVRAM: vi.fn(async () => null) }))
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
  lookupFileMeta: () => null,
  detectProviderModelPath: vi.fn(async () => ''),
  startModelDownloadToPath: (url: string, dir: string, filename: string, bytes?: number, sha?: string) =>
    startModelDownloadToPath(url, dir, filename, bytes, sha),
  luEngineDownloadDir: vi.fn(async () => '/fake/models'),
}))
vi.mock('../../../api/engine', () => ({
  activateBuiltinModel: (name: string) => activateBuiltinModel(name),
}))
vi.mock('../wait-for-download', () => ({
  awaitDownloadComplete: (filename: string) => awaitDownloadComplete(filename),
}))

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

beforeEach(() => {
  useProviderStore.getState().setProviderConfig('ollama', { enabled: false, disabledByUser: true })
  useModelStore.setState({ activeModel: null })
  activateBuiltinModel.mockClear()
})
afterEach(cleanup)

describe('zwei gewaehlte Modelle: das staerkere gewinnt, nicht das zuletzt geklickte', () => {
  it('9B zuerst geklickt, 7B danach: am Ende ist 9B aktiv', async () => {
    await act(async () => {
      render(createElement(ModelsStep, {
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
    })

    // Bewusste Reihenfolge: das staerkere zuerst, das schwaechere zuletzt.
    // Die alte Regel (letzter Klick gewinnt) wuerde damit den 7B-Starter
    // aktiv lassen.
    await act(async () => {
      screen.getByText('Qwen 3.5 9B Abliterated').closest('button')!.click()
    })
    await act(async () => {
      screen.getByText('Qwen 2.5 7B Abliterated (Starter)').closest('button')!.click()
    })

    const installBtn = await screen.findByRole('button', { name: /Install 2 models/i })
    await act(async () => {
      installBtn.click()
    })

    await waitFor(() => {
      expect(activateBuiltinModel).toHaveBeenCalledTimes(3)
    })

    const nineB = ONBOARDING_MODELS.find(m => m.name === 'qwen3.5-9b')!
    const sevenB = ONBOARDING_MODELS.find(m => m.name === 'qwen2.5-7b')!

    // Beide wurden waehrend der Schleife aktiviert (in Klickreihenfolge: 9B,
    // dann 7B) ...
    expect(activateBuiltinModel.mock.calls[0][0]).toBe(builtinModelNameFromPath(nineB.filename))
    expect(activateBuiltinModel.mock.calls[1][0]).toBe(builtinModelNameFromPath(sevenB.filename))
    // ... aber der dritte, abschliessende Aufruf holt das staerkere zurueck.
    expect(activateBuiltinModel.mock.calls[2][0]).toBe(builtinModelNameFromPath(nineB.filename))

    expect(useModelStore.getState().activeModel).toBe(bundledPickerIdForFile(nineB.filename))
  })
})
