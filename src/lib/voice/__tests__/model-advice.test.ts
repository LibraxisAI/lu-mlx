/**
 * The one line the empty Voice surface shows about the selected chat model.
 *
 * Run: npx vitest run src/lib/voice/__tests__/model-advice.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VOICE_MIN_PARAMS_B, VOICE_RECOMMENDED_MODEL, voiceModelAdvice, voiceModelParamsB } from '../model-advice'

describe('advice on the chat model for Voice', () => {
  it('says nothing about a model of 7B or more that takes tools', () => {
    expect(voiceModelAdvice({ name: 'openai::Qwen3.5-9B-Q4_K_M' })).toBeNull()
    expect(voiceModelAdvice({ name: 'openai::Qwen3.5-9B-abliterated.Q4_K_M' })).toBeNull()
    expect(voiceModelAdvice({ name: 'openai::some-model', parameterSize: '8.95B' })).toBeNull()
    expect(voiceModelAdvice({ name: 'openai::Mistral-7B-Instruct' })).toBeNull()
  })

  it('says nothing when no model is selected: the surface already asks for one', () => {
    expect(voiceModelAdvice({ name: null })).toBeNull()
  })

  it('a model that takes no tools gets one sentence that names a model that does', () => {
    const line = voiceModelAdvice({ name: 'openai::Qwen3.5-9B-Q4_K_M', supportsTools: false })
    expect(line).toBe('This model cannot use tools, so Voice can only talk with it. A local model such as Qwen 3.5 9B can also work with files, the web and the screen.')
  })

  it('a model below 7B gets one sentence, by the size the server reports or by its name', () => {
    const small = 'Small models often miss tool calls. Voice works best with a local model from 7B up, such as Qwen 3.5 9B.'
    expect(voiceModelAdvice({ name: 'openai::Qwen3-4B-Q4_K_M' })).toBe(small)
    expect(voiceModelAdvice({ name: 'openai::tiny', parameterSize: '4.02B' })).toBe(small)
    expect(voiceModelAdvice({ name: 'openai::tiny', parameterSize: '494.03M' })).toBe(small)
  })

  it('a model whose size is unknown is left alone', () => {
    expect(voiceModelAdvice({ name: 'openai::my-finetune' })).toBeNull()
  })

  it('reads sizes in billions and millions', () => {
    expect(voiceModelParamsB({ name: 'x', parameterSize: '8.95B' })).toBe(8.95)
    expect(voiceModelParamsB({ name: 'x', parameterSize: '500M' })).toBe(0.5)
    expect(voiceModelParamsB({ name: 'openai::Llama-3.2-3B-Instruct' })).toBe(3)
    expect(voiceModelParamsB({ name: 'openai::unnamed' })).toBeNull()
    expect(VOICE_MIN_PARAMS_B).toBe(7)
  })

  it('names a model the catalog really offers', () => {
    const catalog = readFileSync(resolve(__dirname, '../../../api/discover.ts'), 'utf8')
    expect(catalog).toContain(`{ name: '${VOICE_RECOMMENDED_MODEL}',`)
  })
})
