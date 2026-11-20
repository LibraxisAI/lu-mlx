/**
 * @vitest-environment jsdom
 *
 * Discord 2026-09-28: "DELETE BUTTON pls", with three chat rows that
 * had Bench and Details and no bin. They were LM Studio models. LM Studio has
 * no delete in its API or in `lms` and names no file, so LU cannot delete
 * them without guessing. The owner decided on 2026-10-01 that the row says where
 * the model is deleted. Details also asked Ollama about these rows and then
 * showed nothing at all.
 *
 * Run: npx vitest run src/components/models/__tests__/an-lm-studio-row-says-where-it-is-deleted.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const activateBuiltinModel = vi.fn(async () => true)
const showModel = vi.fn(async () => ({ license: 'x' }))
/** Was die Engine gerade tut. Ueberschreibbar, siehe den Fall zum toten
 *  Prozess weiter unten. */
const engineStatus = vi.fn(async () => ({ running: true, healthy: true, port: 8127 }))

// Die Seite hat seit dem 08.10.2026 zwei Fassungen: die klassische auf
// Windows und Linux, das Redesign auf dem Mac (skin/which.ts entscheidet).
// Die Regeln, die diese Datei bewacht, gelten fuer beide, also laeuft jeder
// Fall einmal je Fassung.
const face = vi.hoisted(() => ({ name: 'classic' as 'classic' | 'mac' }))
vi.mock('../skin/which', () => ({ modelSkinName: () => face.name }))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../../api/comfyui', async () => {
  const actual = await vi.importActual<typeof import('../../../api/comfyui')>('../../../api/comfyui')
  return {
    ...actual,
    getInstalledImageModels: vi.fn(async () => []),
    getInstalledVideoModels: vi.fn(async () => []),
    checkComfyConnection: vi.fn(async () => false),
    refreshComfyModels: vi.fn(async () => undefined),
    readModelDiskSizes: vi.fn(async () => new Map()),
    getSystemVRAM: vi.fn(async () => 0),
  }
})
vi.mock('../../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  unloadModel: vi.fn(async () => undefined),
  pullModel: vi.fn(), pullModelTauri: vi.fn(), deleteModel: vi.fn(), showModel: (...a: unknown[]) => showModel(...(a as [])),
}))
vi.mock('../../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../../api/providers')>('../../../api/providers')
  return { ...actual, getEnabledProviders: () => [] }
})
vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => []),
    customModelDirs: vi.fn(async () => []),
    isManagedBuiltinActive: () => true,
    bundledEngineStatus: (...a: unknown[]) => engineStatus(...(a as [])),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: (...a: unknown[]) => activateBuiltinModel(...(a as [])),
  }
})

const { ModelManager } = await import('../ModelManager')
const { useModelStore } = await import('../../../stores/modelStore')
const { useProviderStore } = await import('../../../stores/providerStore')
const { __resetLuEngineSwapLockForTests } = await import('../../../api/lu-engine-swap-lock')
const { displayModelName } = await import('../../../api/providers/model-name')

const LU = 'openai::Phi-4-mini-instruct-Q4_K_M'
const LMS = 'openai::gemma-3n-e4b'
const ROUTER = 'openai::meta-llama/llama-3.3-70b-instruct'
const OLLAMA = 'llama3.2:3b'

function installedList(providerName = 'LM Studio') {
  return [
    { name: LU, model: 'Phi-4-mini-instruct-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
    { name: LMS, model: 'gemma-3n-e4b', size: 1, type: 'text', provider: 'openai', providerName },
    { name: ROUTER, model: 'meta-llama/llama-3.3-70b-instruct', size: 1, type: 'text', provider: 'openai', providerName: 'OpenRouter' },
    { name: OLLAMA, model: OLLAMA, size: 1, type: 'text', provider: 'ollama', providerName: 'Ollama' },
  ] as never
}

async function openInstalled(providerName?: string) {
  render(createElement(ModelManager))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  fireEvent.click(screen.getByText('Installed'))
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
  await act(async () => {
    useModelStore.setState({ models: installedList(providerName), activeModel: LU })
    await Promise.resolve()
  })
}

function row(name: string): HTMLElement {
  const el = document.querySelector(`span[title="${displayModelName(name)}"]`)
  if (!el) throw new Error(`no row for ${name}`)
  // The row is found by its surface: the corner radius it spells out in the
  // classic face, the house surface `.lu-tile` in the Mac face.
  const surface = el.closest(face.name === 'mac' ? '.lu-tile' : 'div[class*="rounded-lg"]')
  if (!surface) throw new Error(`no row surface for ${name} in the ${face.name} face`)
  return surface as HTMLElement
}
const detailsOf = (name: string) => row(name).querySelector('button[title^="Details"]') as HTMLButtonElement

beforeEach(() => {
  showModel.mockClear()
  __resetLuEngineSwapLockForTests()
  useProviderStore.getState().resetProvidersToDefaults()
  useProviderStore.getState().setProviderConfig('openai', {
    enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
  })
  useModelStore.setState({ models: installedList(), activeModel: LU, categoryFilter: 'text' })
})
afterEach(() => { cleanup(); __resetLuEngineSwapLockForTests() })

describe.each(['classic', 'mac'] as const)('Fassung %s', (fassung) => {
  beforeEach(() => { face.name = fassung })

  describe('a chat model LM Studio serves', () => {
    it('Details says to delete it in LM Studio, without asking Ollama', async () => {
      await openInstalled()
      expect(detailsOf(LMS).title).toContain('Delete it in LM Studio under My Models')
      await act(async () => { fireEvent.click(detailsOf(LMS)) })
      expect(screen.getByText('This model belongs to LM Studio. Delete it in LM Studio under My Models.')).toBeTruthy()
      expect(showModel).not.toHaveBeenCalled()
    })

    it('another local server is named the same way', async () => {
      await openInstalled('KoboldCpp')
      await act(async () => { fireEvent.click(detailsOf(LMS)) })
      expect(screen.getByText('This model belongs to KoboldCpp. Delete it there.')).toBeTruthy()
    })

    // Negative controls: rows that can be deleted, or have nothing to delete.
    it('an Ollama row keeps its bin and asks Ollama for its details', async () => {
      await openInstalled()
      expect(detailsOf(OLLAMA).title).toBe('Details')
      await act(async () => { fireEvent.click(detailsOf(OLLAMA)) })
      expect(showModel).toHaveBeenCalledWith(OLLAMA)
      expect(screen.queryByText(/Delete it/)).toBeNull()
    })

    it('a cloud row and an LU Engine row get no such line', async () => {
      await openInstalled()
      expect(detailsOf(ROUTER).title).toBe('Details')
      expect(detailsOf(LU).title).toBe('Details')
    })
  })
})
