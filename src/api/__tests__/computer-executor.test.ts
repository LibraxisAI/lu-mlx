import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executorCandidates, modelSeesImages, resolveExecutor } from '../computer-executor'
import { useComputerStore } from '../../stores/computerStore'
import { useModelStore } from '../../stores/modelStore'
import type { AIModel } from '../../types/models'

vi.mock('../vision-feedback', () => ({
  // The provider is not asked in a unit test: a declared flag decides, and
  // without one the family name does.
  modelCanSee: vi.fn(async (model: string, _provider: string, declared?: boolean) => declared ?? /gemma|llava|qwen3\.8/.test(model)),
}))

/** What the LU Engine says about its models right now. Null: it does not answer. */
const engine = vi.hoisted(() => ({ models: null as null | { name: string; path: string; size: number; loaded: boolean; vision?: boolean; imagePart?: boolean }[], asked: 0 }))
vi.mock('../engine', () => ({
  listBundledModels: vi.fn(async () => {
    engine.asked += 1
    if (!engine.models) throw new Error('the engine does not answer')
    return engine.models
  }),
}))

const text = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'text', ...extra }) as unknown as AIModel

const MODELS: AIModel[] = [
  text('gemma3:12b'),
  text('qwen2.5:7b'),
  text('lu-cloud::vendor/sees', { supportsVision: true }),
  text('lu-cloud::vendor/blind', { supportsVision: false }),
  // A cloud row that only sounds like a vision model is not offered: the catalog decides.
  text('lu-cloud::vendor/llava-like'),
  { name: 'flux-dev', type: 'image' } as unknown as AIModel,
]

beforeEach(() => {
  engine.models = null
  engine.asked = 0
  useComputerStore.setState({ executorModel: null })
  useModelStore.setState({ models: MODELS, activeModel: 'qwen2.5:7b' })
})

describe('executorCandidates', () => {
  it('offers local models that can see and cloud models the catalog lists with image input', () => {
    expect(executorCandidates(MODELS).map((c) => [c.name, c.where])).toEqual([
      ['gemma3:12b', 'local'],
      ['lu-cloud::vendor/sees', 'cloud'],
    ])
  })
})

describe('resolveExecutor', () => {
  it('stays with the chat model when it cannot see, and says that it cannot', async () => {
    // One model in memory beats two that swap. Whether a blind model can work
    // (the system lists the elements of a window) is the task's question.
    expect(await resolveExecutor()).toMatchObject({ model: 'qwen2.5:7b', format: 'generic', sees: false })
  })

  it('has none without a chat model and without a choice', async () => {
    useModelStore.setState({ activeModel: null })
    expect(await resolveExecutor()).toBeNull()
  })

  it('uses the chat model when it can see', async () => {
    useModelStore.setState({ activeModel: 'gemma3:12b' })
    expect(await resolveExecutor()).toMatchObject({ model: 'gemma3:12b', format: 'generic', sees: true })
  })

  // The owner's test machine, October 2026: Qwen 3.5 9B without its image
  // part worked blind. The name says nothing (the family is not in the name
  // list), so the engine's word about the part is the whole answer.
  it('hands the chat model the screenshots as soon as its image part is loaded', async () => {
    const name = 'openai::Qwen3.5-9B-abliterated.Q4_K_M'
    const row = (sees: boolean) => text(name, { provider: 'openai', providerName: 'LU Engine', supportsVision: sees })
    useModelStore.setState({ models: [row(false)], activeModel: name })
    expect(await resolveExecutor()).toMatchObject({ model: name, sees: false })
    useModelStore.setState({ models: [row(true)], activeModel: name })
    expect(await resolveExecutor()).toMatchObject({ model: name, format: 'generic', sees: true })
  })

  it('uses the chosen model, whatever the chat model is', async () => {
    useComputerStore.setState({ executorModel: 'lu-cloud::vendor/sees' })
    expect(await resolveExecutor()).toMatchObject({ model: 'lu-cloud::vendor/sees', sees: true })
  })

  it('falls back to the chat model when the chosen one is gone from the list', async () => {
    useComputerStore.setState({ executorModel: 'deleted:9b' })
    expect(await resolveExecutor()).toMatchObject({ model: 'qwen2.5:7b', sees: false })
    useModelStore.setState({ activeModel: 'gemma3:12b' })
    expect(await resolveExecutor()).toMatchObject({ model: 'gemma3:12b', sees: true })
  })

  it('speaks the Holo format to a Holo model', async () => {
    useModelStore.setState({ models: [...MODELS, text('Holo-3.1-9B.Q4_K_M', { supportsVision: true })] })
    useComputerStore.setState({ executorModel: 'Holo-3.1-9B.Q4_K_M' })
    expect(await resolveExecutor()).toMatchObject({ format: 'holo' })
  })
})

// The owner's rule of 09.10.2026: computer control with or without the
// picture is no question. It follows the model, as it is loaded right now.
describe('with the picture or from the list: the model decides, in one place', () => {
  const NAME = 'openai::Qwen3.5-9B-abliterated.Q4_K_M'
  const PATH = 'C:\\models\\Qwen3.5-9B-abliterated.Q4_K_M.gguf'
  const row = (listSays: boolean | undefined) => text(NAME, { provider: 'openai', providerName: 'LU Engine', path: PATH, ...(listSays === undefined ? {} : { supportsVision: listSays }) })
  const loaded = (vision: boolean, imagePart: boolean) => [{ name: 'Qwen3.5-9B-abliterated.Q4_K_M', path: PATH, size: 1, loaded: true, vision, imagePart }]

  it('a model that is loaded with its image part gets the picture', async () => {
    useModelStore.setState({ models: [row(true)], activeModel: NAME })
    engine.models = loaded(true, true)
    expect(await resolveExecutor()).toMatchObject({ model: NAME, sees: true })
  })

  it('a model without image input works from the list', async () => {
    useModelStore.setState({ models: [row(false)], activeModel: NAME })
    engine.models = loaded(false, false)
    expect(await resolveExecutor()).toMatchObject({ model: NAME, sees: false })
  })

  it('the image part lies next to the model and is not loaded: the list, whatever the model list remembered', async () => {
    // The list was read while another model was loaded: the part is on disk, so it said yes.
    useModelStore.setState({ models: [row(true)], activeModel: NAME })
    // Then this model was loaded, and the card had no room for the part.
    engine.models = loaded(false, true)
    expect(await resolveExecutor()).toMatchObject({ model: NAME, sees: false })
    expect(engine.asked).toBe(1)
  })

  it('the other way round: the part was added and the model loaded again, the list still says no', async () => {
    useModelStore.setState({ models: [row(false)], activeModel: NAME })
    engine.models = loaded(true, true)
    expect(await modelSeesImages(NAME)).toBe(true)
  })

  it('a model the user picked is asked the same way: picked does not mean loaded with its part', async () => {
    useModelStore.setState({ models: [text('qwen2.5:7b'), row(true)], activeModel: 'qwen2.5:7b' })
    useComputerStore.setState({ executorModel: NAME })
    engine.models = loaded(false, true)
    expect(await resolveExecutor()).toMatchObject({ model: NAME, sees: false })
  })

  it('an engine that does not answer leaves the word of the model list', async () => {
    useModelStore.setState({ models: [row(true)], activeModel: NAME })
    expect(await modelSeesImages(NAME)).toBe(true)
    useModelStore.setState({ models: [row(false)], activeModel: NAME })
    expect(await modelSeesImages(NAME)).toBe(false)
  })

  it('a model of another runtime or of the cloud is not asked at the engine', async () => {
    useModelStore.setState({ models: MODELS, activeModel: 'lu-cloud::vendor/sees' })
    engine.models = []
    expect(await resolveExecutor()).toMatchObject({ sees: true })
    useModelStore.setState({ activeModel: 'qwen2.5:7b' })
    expect(await resolveExecutor()).toMatchObject({ sees: false })
    expect(engine.asked).toBe(0)
  })

  it('nothing in the way from the model to the task asks the user or offers a download', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const read = (file: string) => readFileSync(resolve(__dirname, '..', '..', file), 'utf8')
    for (const file of ['api/computer-executor.ts', 'api/computer-task.ts', 'lib/computer/screen-model-hint.ts']) {
      const source = read(file)
      expect(source, file).not.toMatch(/AddImageInput|addImagePart|askPermission|Settings under Permissions|can be picked/)
    }
    // The settings of computer control say what the model works with, and carry no button for the image part.
    expect(read('components/settings/PermissionSettings.tsx')).not.toMatch(/AddImageInput|useImagePartOffer/)
  })
})
