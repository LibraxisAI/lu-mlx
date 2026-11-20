/**
 * In Cloud mode the app never picks a chat model by itself (2026-10-05).
 *
 * Measured that day (lu-305/mail/TEST-VERWEIGERUNG-2026-10-05.md): a new
 * account got the head of the hosted catalogue, Llama 3.1 8B Turbo, without
 * ever having picked it. That model declines adult fiction, and once a refusal
 * stands in the history, better models in the same chat copy it.
 *
 * Two places handed out that model: `setModels` in this store, which takes the
 * first chat row of at least 7B when no valid pick is there, and the
 * Local/Cloud rule in lib/active-model-mode, which did the same on the way
 * into Cloud. Both are covered here. A pick the user made earlier and that is
 * still in the list stays, in both places. Local mode keeps its rule.
 *
 * Run: npx vitest run src/stores/__tests__/cloud-waehlt-kein-chatmodell-von-selbst.test.ts
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

import { useModelStore } from '../modelStore'
import { useSettingsStore } from '../settingsStore'
import { pickForMode } from '../../lib/active-model-mode'
import type { AIModel } from '../../types/models'

const LLAMA = 'lu-cloud::llama-3.1-8b-turbo'
const GLM = 'lu-cloud::glm-5.3'
const QWEN_LOCAL = 'openai::Qwen3-14B-Q4_K_M'

const cloud = (name: string) => ({
  name, model: name, size: 0, type: 'text' as const,
  provider: 'lu-cloud' as const, providerName: 'LU Cloud',
}) as AIModel
const local = (name: string) => ({
  name, model: name, size: 0, type: 'text' as const,
  provider: 'openai' as const, providerName: 'LU Engine',
}) as AIModel

/** The head of the catalogue first, exactly as `/v1/models` answers. */
const CATALOGUE = [cloud(LLAMA), cloud(GLM)]

const setMode = (appMode: 'cloud' | 'local') =>
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, appMode } }))

beforeEach(() => {
  useModelStore.setState({ models: [], activeModel: null, lastCloudModel: null, lastLocalModel: null })
  setMode('cloud')
})

describe('setModels in Cloud mode', () => {
  it('THE FIX: a new account ends up with no chat model, not with the head of the catalogue', () => {
    useModelStore.getState().setModels(CATALOGUE)
    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('a pick the user made earlier and that is still listed stays', () => {
    useModelStore.setState({ activeModel: GLM })
    useModelStore.getState().setModels(CATALOGUE)
    expect(useModelStore.getState().activeModel).toBe(GLM)
  })

  it('a pick that left the catalogue is cleared, nothing takes its place', () => {
    useModelStore.setState({ activeModel: 'lu-cloud::retired-model-70b' })
    useModelStore.getState().setModels(CATALOGUE)
    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('a local model of the right size is not handed out in Cloud mode either', () => {
    useModelStore.getState().setModels([local(QWEN_LOCAL), ...CATALOGUE])
    expect(useModelStore.getState().activeModel).toBeNull()
  })
})

describe('setModels in Local mode', () => {
  beforeEach(() => setMode('local'))

  it('never falls on a hosted model, even when the catalogue heads the list', () => {
    useModelStore.getState().setModels(CATALOGUE)
    expect(useModelStore.getState().activeModel).toBeNull()
  })

  it('NEGATIVE CONTROL: the local automatic pick is unchanged', () => {
    useModelStore.getState().setModels([...CATALOGUE, local(QWEN_LOCAL)])
    expect(useModelStore.getState().activeModel).toBe(QWEN_LOCAL)
  })
})

describe('the Local/Cloud rule on the way into Cloud', () => {
  const rows = [
    { name: QWEN_LOCAL, type: 'text', provider: 'openai' },
    { name: LLAMA, type: 'text', provider: 'lu-cloud' },
    { name: GLM, type: 'text', provider: 'lu-cloud' },
  ]
  const none = { local: null, cloud: null }

  it('THE FIX: nothing picked and nothing remembered stays nothing', () => {
    expect(pickForMode(null, rows, 'cloud', null, none)).toMatchObject({ change: false, next: null })
  })

  it('a local pick is cleared on the flip, and no hosted model replaces it', () => {
    expect(pickForMode(QWEN_LOCAL, rows, 'cloud', null, { local: QWEN_LOCAL, cloud: null }))
      .toMatchObject({ change: true, next: null })
  })

  it('the last Cloud pick of the user comes back', () => {
    expect(pickForMode(QWEN_LOCAL, rows, 'cloud', null, { local: QWEN_LOCAL, cloud: GLM }))
      .toMatchObject({ change: true, next: GLM })
  })

  it('a row the user named on the way in is taken', () => {
    expect(pickForMode(QWEN_LOCAL, rows, 'cloud', GLM, none))
      .toMatchObject({ change: true, next: GLM, usedRequest: true })
  })

  it('a valid Cloud pick is left alone', () => {
    expect(pickForMode(LLAMA, rows, 'cloud', null, none)).toMatchObject({ change: false, next: LLAMA })
  })

  it('NEGATIVE CONTROL: back in Local the first model of at least 7B still steps in', () => {
    expect(pickForMode(GLM, rows, 'local', null, none)).toMatchObject({ change: true, next: QWEN_LOCAL })
  })
})
