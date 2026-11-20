/**
 * @vitest-environment jsdom
 *
 * The onboarding model step, rendered on a Mac.
 *
 * The pure half is in src/lib/__tests__/onboarding-shared-memory.test.ts. This
 * file proves ModelsStep is wired to it: where "Recommended" sits for a given
 * amount of memory, which card carries an advisory, and that no card says
 * VRAM, GPU or RTX. Where the pool comes from (the Apple entry of
 * detect_gpus, system_info behind it) is src/lib/__tests__/hardware.test.ts.
 * The Windows side of the same screen is
 * empfehlung-folgt-der-hardware.test.tsx, which stays as it is.
 *
 * Negative control: with ModelsStep as it was (getMaxVramGb, then ComfyUI,
 * no look at the memory) the 16 GB case has its badge on the 7B, the 8 GB
 * case has no advisory, and the wording case finds "VRAM" and "RTX 3060".
 *
 * Run: npx vitest run src/components/onboarding/__tests__/mac-empfehlung-folgt-dem-speicher.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const platform = vi.hoisted(() => ({ mac: true }))
const getMaxVramGb = vi.fn(async () => 0)
const getSharedMemoryGb = vi.fn(async () => 0)
const getSystemVRAM = vi.fn(async () => null)

vi.mock('../../../lib/hardware', () => ({
  getMaxVramGb: () => getMaxVramGb(),
  getSharedMemoryGb: () => getSharedMemoryGb(),
}))
vi.mock('../../../api/comfyui', () => ({ getSystemVRAM: () => getSystemVRAM() }))
vi.mock('../../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  pullModelTauri: vi.fn(),
  checkConnection: vi.fn(async () => false),
}))
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => false,
  isMacOS: () => platform.mac,
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

const EMPTY_FLEET = {
  ollama: { phase: 'idle' }, lmstudio: { phase: 'idle' },
  comfyInstall: { phase: 'idle' }, pythonInstall: { phase: 'idle' },
  ollamaDo: () => {}, lmstudioDo: () => {}, comfyInstallDo: () => {}, pythonInstallDo: () => {},
  secondsOf: () => 0,
}
const EMPTY_SCAN = {
  detectedBackends: [], detecting: false, selectedBackend: 'builtin',
  setSelectedBackend: () => {}, lmstudioOfflineDetected: false, lmstudioModelCount: 0,
  runDetection: async () => {}, stopDetection: () => {},
}

function draw() {
  return render(createElement(ModelsStep, {
    skin: onboardingSkin(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scan: EMPTY_SCAN as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fleet: EMPTY_FLEET as any,
    step: 'models' as const,
    setStep: () => {},
    pulledModels: [],
    setPulledModels: () => {},
  }))
}

function cardOf(label: string): HTMLElement {
  const button = screen.getByText(label).closest('button')
  expect(button, `no card for "${label}"`).not.toBeNull()
  return button as HTMLElement
}

const SEVEN_B = 'Qwen 2.5 7B Abliterated (Starter)'
const NINE_B = 'Qwen 3.5 9B Abliterated'

beforeEach(() => {
  platform.mac = true
  useProviderStore.getState().setProviderConfig('ollama', { enabled: false, disabledByUser: true })
  useModelStore.setState({ activeModel: null })
})
afterEach(() => {
  cleanup()
  for (const probe of [getMaxVramGb, getSharedMemoryGb]) {
    probe.mockReset()
    probe.mockImplementation(async () => 0)
  }
  getSystemVRAM.mockReset()
  getSystemVRAM.mockImplementation(async () => null)
})

describe('a Mac, its memory pool read through getSharedMemoryGb', () => {
  it('16 GB: Recommended sits on the 9B, and nothing is warned about', async () => {
    getSharedMemoryGb.mockImplementation(async () => 16)
    draw()
    await waitFor(() => expect(cardOf(NINE_B).textContent).toContain('Recommended'))
    expect(cardOf(SEVEN_B).textContent).not.toContain('Recommended')
    expect(screen.getAllByText('Recommended', { exact: true })).toHaveLength(1)
    expect(screen.queryAllByTestId('onboarding-model-advisory')).toHaveLength(0)
  })

  it('64 GB: still the 9B, not the 7B starter every Mac used to get', async () => {
    getSharedMemoryGb.mockImplementation(async () => 64)
    draw()
    await waitFor(() => expect(cardOf(NINE_B).textContent).toContain('Recommended'))
    expect(cardOf(SEVEN_B).textContent).not.toContain('Recommended')
  })

  it('8 GB: Recommended stays on the 7B and the 9B says it is a tight fit', async () => {
    getSharedMemoryGb.mockImplementation(async () => 8)
    draw()
    await waitFor(() => expect(screen.getAllByTestId('onboarding-model-advisory')).toHaveLength(1))
    expect(cardOf(NINE_B).textContent).toContain('Barely fits. With other apps open it can slow down.')
    expect(cardOf(SEVEN_B).textContent).toContain('Recommended')
    expect(cardOf(NINE_B).textContent).not.toContain('Recommended')
    expect(cardOf(SEVEN_B).querySelector('[data-testid="onboarding-model-advisory"]')).toBeNull()
  })

  it('neither a card nor ComfyUI is asked on a Mac: it has neither', async () => {
    getSharedMemoryGb.mockImplementation(async () => 16)
    getMaxVramGb.mockImplementation(async () => 4)
    draw()
    await waitFor(() => expect(cardOf(NINE_B).textContent).toContain('Recommended'))
    expect(getSystemVRAM).not.toHaveBeenCalled()
    expect(getMaxVramGb).not.toHaveBeenCalled()
  })
})

describe('the words on a Mac', () => {
  it('no card says VRAM, GPU, RTX or PC; they say memory', async () => {
    getSharedMemoryGb.mockImplementation(async () => 8)
    draw()
    await waitFor(() => expect(screen.getAllByTestId('onboarding-model-advisory')).toHaveLength(1))
    for (const label of [SEVEN_B, NINE_B]) {
      const text = cardOf(label).textContent ?? ''
      expect(text, label).not.toMatch(/VRAM|GPU|RTX|offload|your PC/)
      expect(text, label).toContain('Memory: about')
    }
  })
})

describe('WINDOWS CONTROL: the same screen on a PC is untouched', () => {
  it('a 5 GB card reads the PC advisory and the PC memory line, word for word', async () => {
    platform.mac = false
    getMaxVramGb.mockImplementation(async () => 5)
    getSharedMemoryGb.mockImplementation(async () => 64)
    draw()
    await waitFor(() => expect(screen.getAllByTestId('onboarding-model-advisory')).toHaveLength(2))
    const nine = cardOf(NINE_B).textContent ?? ''
    expect(nine).toContain('Full GPU offload may not fit. Use CPU/offload settings or skip local setup.')
    // Since 3.0.6 the 9B brings its image part, and the size line names it
    // (integ/astra-306, f48128b0). The rest of the line is the PC wording.
    expect(nine).toContain('5.2 GiB + 0.9 GiB image input · VRAM: about 6.1 GB for GPU offload, context-dependent')
    expect(nine).toContain('Needs about 6.1 GB VRAM, measured on an RTX 3060 with full GPU offload.')
    // 64 GB of RAM do not make a PC recommend by memory: the card decides.
    expect(cardOf(SEVEN_B).textContent).toContain('Recommended')
    expect(nine).not.toContain('Recommended')
  })

  it('a 12 GB card recommends the 9B, as before', async () => {
    platform.mac = false
    getMaxVramGb.mockImplementation(async () => 12)
    draw()
    await waitFor(() => expect(cardOf(NINE_B).textContent).toContain('Recommended'))
    expect(screen.queryAllByTestId('onboarding-model-advisory')).toHaveLength(0)
  })
})
