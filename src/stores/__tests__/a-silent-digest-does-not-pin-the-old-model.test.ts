import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Probe, 10.10.2026 (the owner, Mac hand test of 3.0.6): Voice on an Ollama 27B,
 * session ended, back to Chat, picked a 9B, pressed the load switch on the 9B
 * row. The switch span for as long as he watched, and the 27B row stood greyed
 * and "On".
 *
 * The Ollama log of that minute: the voice session ended at 12:13:32, and in
 * the same second a POST /api/chat started on the 27B and ran for 91 s. That
 * is the memory digest of the voice session (`VoiceHistory.finish` hands the
 * session to `extractMemoriesFromPair`), a silent call nobody sees. It books
 * the local lane under `<conversation>::memory-extraction`.
 *
 * `setActiveModel` unloads the previous local model through
 * `deferLocalUnload`, which waits for the local lane to be free. So the pick
 * sent nothing at all to Ollama, the 27B stayed resident and busy, and the
 * load of the 9B (POST /api/generate from the row switch) queued behind it
 * inside Ollama for 78 s until the app was closed.
 *
 * Deferring behind a turn the user is watching is right. Deferring a model
 * switch the user just asked for behind a silent background call is the bug:
 * the background call has to give way.
 *
 * Run: npx vitest run src/stores/__tests__/a-silent-digest-does-not-pin-the-old-model.test.ts
 */

const backendCall = vi.fn(async (..._args: unknown[]) => ({}))
const unloadModel = vi.fn(async (..._args: unknown[]) => undefined)
const unloadLmStudioModel = vi.fn(async (..._args: unknown[]) => undefined)

vi.mock('../../api/backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => true,
}))
vi.mock('../../api/ollama', () => ({
  unloadModel: (...a: unknown[]) => unloadModel(...a),
}))
vi.mock('../../api/lmstudio', () => ({
  unloadLmStudioModel: (...a: unknown[]) => unloadLmStudioModel(...a),
}))

import { useModelStore, __resetDeferredLocalUnloadsForTests } from '../modelStore'
import { useGenerationStore } from '../generationStore'
import type { AIModel } from '../../types/models'

const ollamaModel = (name: string): AIModel =>
  ({ name, model: name, size: 1, type: 'text', provider: 'ollama', providerName: 'Ollama' } as unknown as AIModel)

const OLD = 'hf.co/someone/Qwen-27B-GGUF:Q4_K_M'
const NEW = 'hf.co/someone/Small-9B-GGUF:Q4_K_M'
/** The identity `extractMemoriesFromPair` books its silent call under. */
const DIGEST_RUN = 'voice-conversation::memory-extraction'
const RUN_TOKEN = {}

beforeEach(() => {
  backendCall.mockClear()
  unloadModel.mockClear()
  unloadLmStudioModel.mockClear()
  __resetDeferredLocalUnloadsForTests()
  useModelStore.setState({ models: [ollamaModel(OLD), ollamaModel(NEW)], activeModel: OLD })
  useGenerationStore.setState({ runs: {}, generating: {}, aborters: {} })
})

describe('a pick while only a silent memory digest holds the local lane', () => {
  it('stops the digest and unloads the old model, instead of waiting the digest out', () => {
    const stopDigest = vi.fn(() => {
      // What `run-slot.ts` does in its `finally` once the aborted call returns.
      useGenerationStore.getState().endRun(DIGEST_RUN, RUN_TOKEN)
    })
    useGenerationStore.getState().bookRun(DIGEST_RUN, 'local', RUN_TOKEN)
    useGenerationStore.getState().registerAborter(DIGEST_RUN, stopDigest)

    useModelStore.getState().setActiveModel(NEW)

    expect(stopDigest).toHaveBeenCalledTimes(1)
    expect(unloadModel).toHaveBeenCalledWith(OLD)
  })

  it('Gegenprobe: a turn the user is watching still holds the unload back', () => {
    useGenerationStore.getState().bookRun('a-visible-chat', 'local', RUN_TOKEN)

    useModelStore.getState().setActiveModel(NEW)

    expect(unloadModel).not.toHaveBeenCalled()
    useGenerationStore.getState().endRun('a-visible-chat', RUN_TOKEN)
    expect(unloadModel).toHaveBeenCalledWith(OLD)
  })
})
