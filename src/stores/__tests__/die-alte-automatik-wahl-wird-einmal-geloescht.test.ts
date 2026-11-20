// @vitest-environment jsdom
/**
 * The old automatic Cloud pick is cleared once (3.0.5, 2026-10-05).
 *
 * Until 3.0.5 the app put the head of the hosted catalogue into the picker by
 * itself: Llama 3.1 8B Turbo, the first hosted row that passed the 7B rule.
 * It declines adult fiction, and a refusal in the history is copied by better
 * models in the same chat. New accounts get no automatic pick any more, but an
 * account that already has that model stored would keep chatting on it. A
 * stored pick of exactly that model cannot be told from a deliberate one, so
 * it is cleared one time. The marker makes it one time: a later deliberate
 * pick of the same model stays.
 *
 * Driven through the real persist layer: the stored state is written to
 * localStorage and the store rehydrates from it.
 *
 * Run: npx vitest run src/stores/__tests__/die-alte-automatik-wahl-wird-einmal-geloescht.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => false),
  backendCall: vi.fn(async () => undefined),
}))
vi.mock('../../api/ollama', () => ({ unloadModel: vi.fn(async () => undefined) }))
vi.mock('../../api/lmstudio', () => ({ unloadLmStudioModel: vi.fn(async () => undefined) }))
vi.mock('../../api/engine', () => ({ activateBuiltinModel: vi.fn(async () => undefined) }))

import { useModelStore, RETIRED_AUTO_CLOUD_PICK } from '../modelStore'
import { useSettingsStore } from '../settingsStore'
import type { AIModel } from '../../types/models'

const KEY = 'chat-models'
const GLM = 'lu-cloud::glm-5.3'
const LOCAL = 'openai::Qwen3-14B-Q4_K_M'

interface Stored {
  activeModel: string | null
  lastLocalModel: string | null
  lastCloudModel: string | null
  autoCloudPickCleared?: boolean
}

async function startWith(stored: Stored) {
  localStorage.setItem(KEY, JSON.stringify({ state: { categoryFilter: 'all', ...stored }, version: 0 }))
  await useModelStore.persist.rehydrate()
  return useModelStore.getState()
}
const onDisk = (): Stored => JSON.parse(localStorage.getItem(KEY)!).state

const cloud = (name: string) => ({
  name, model: name, size: 0, type: 'text' as const, provider: 'lu-cloud' as const, providerName: 'LU Cloud',
}) as AIModel

beforeEach(() => {
  localStorage.clear()
  useModelStore.setState({
    models: [], activeModel: null, lastLocalModel: null, lastCloudModel: null, autoCloudPickCleared: false,
  })
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, appMode: 'cloud' } }))
})

describe('an account that still carries the automatic pick', () => {
  it('the model is the head of the hosted catalogue by its real id', () => {
    expect(RETIRED_AUTO_CLOUD_PICK).toBe('lu-cloud::meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
  })

  it('THE FIX: the stored pick is cleared, and so is the memory of the Cloud side', async () => {
    const s = await startWith({ activeModel: RETIRED_AUTO_CLOUD_PICK, lastLocalModel: LOCAL, lastCloudModel: RETIRED_AUTO_CLOUD_PICK })
    expect(s.activeModel).toBeNull()
    expect(s.lastCloudModel).toBeNull()
    expect(s.lastLocalModel).toBe(LOCAL)
    expect(s.autoCloudPickCleared).toBe(true)
  })

  it('a user in Local mode loses only the remembered Cloud side', async () => {
    const s = await startWith({ activeModel: LOCAL, lastLocalModel: LOCAL, lastCloudModel: RETIRED_AUTO_CLOUD_PICK })
    expect(s.activeModel).toBe(LOCAL)
    expect(s.lastCloudModel).toBeNull()
  })

  it('the catalogue arriving afterwards does not put the model back', async () => {
    await startWith({ activeModel: RETIRED_AUTO_CLOUD_PICK, lastLocalModel: null, lastCloudModel: RETIRED_AUTO_CLOUD_PICK })
    useModelStore.getState().setModels([cloud(RETIRED_AUTO_CLOUD_PICK), cloud(GLM)])
    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('ONCE: picking that same model on purpose afterwards survives the next start', async () => {
    await startWith({ activeModel: RETIRED_AUTO_CLOUD_PICK, lastLocalModel: null, lastCloudModel: RETIRED_AUTO_CLOUD_PICK })
    useModelStore.getState().setModels([cloud(RETIRED_AUTO_CLOUD_PICK), cloud(GLM)])
    useModelStore.getState().setActiveModel(RETIRED_AUTO_CLOUD_PICK)
    // The marker went to disk together with the deliberate pick.
    expect(onDisk()).toMatchObject({ activeModel: RETIRED_AUTO_CLOUD_PICK, autoCloudPickCleared: true })
    // The next start of the app.
    useModelStore.setState({ activeModel: null, lastCloudModel: null, autoCloudPickCleared: false })
    localStorage.setItem(KEY, JSON.stringify({
      state: { categoryFilter: 'all', activeModel: RETIRED_AUTO_CLOUD_PICK, lastLocalModel: null, lastCloudModel: RETIRED_AUTO_CLOUD_PICK, autoCloudPickCleared: true },
      version: 0,
    }))
    await useModelStore.persist.rehydrate()
    expect(useModelStore.getState().activeModel).toBe(RETIRED_AUTO_CLOUD_PICK)
    expect(useModelStore.getState().lastCloudModel).toBe(RETIRED_AUTO_CLOUD_PICK)
  })
})

describe('what the clearing leaves alone', () => {
  it('NEGATIVE CONTROL: any other stored Cloud pick stays', async () => {
    const s = await startWith({ activeModel: GLM, lastLocalModel: null, lastCloudModel: GLM })
    expect(s.activeModel).toBe(GLM)
    expect(s.lastCloudModel).toBe(GLM)
    expect(s.autoCloudPickCleared).toBe(true)
  })

  it('NEGATIVE CONTROL: a stored local pick stays, and still seeds its memory (R2-27)', async () => {
    const s = await startWith({ activeModel: LOCAL, lastLocalModel: null, lastCloudModel: null })
    expect(s.activeModel).toBe(LOCAL)
    expect(s.lastLocalModel).toBe(LOCAL)
  })

  it('a new install is marked as done, so its first deliberate pick is never touched', async () => {
    await useModelStore.persist.rehydrate()
    expect(useModelStore.getState().autoCloudPickCleared).toBe(true)
    expect(useModelStore.getState().activeModel).toBeNull()
  })
})
