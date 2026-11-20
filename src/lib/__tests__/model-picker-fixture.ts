import { cloudModelRow } from '../cloud-model-row'
import type { AIModel } from '../../types/models'

/**
 * A small hosted catalogue for the picker tests, in the shape the LU Cloud
 * models route sends it and the model store keeps it. Small on purpose: every
 * row is here for a reason the tests name.
 */
export interface PickerFixtureModel {
  id: string
  label: string
  unfiltered?: 'full' | 'partial'
  vision?: boolean
  think?: 'toggle' | 'always' | 'never'
  /** A Flash model: no credits on a paid plan. */
  flash?: boolean
  /** The context window the server stated. Absent = it stated none. */
  context?: number
  /** Credits per one million tokens [input, output]. Absent = an older server. */
  rates?: [number, number]
  /** false = the server said this model cannot call tools. */
  tools?: boolean
}

export const PICKER_FIXTURE: PickerFixtureModel[] = [
  { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'Llama 3.1 8B Turbo', think: 'never', context: 131072, rates: [2000, 3000] },
  { id: 'Qwen/Qwen3-30B-A3B', label: 'Qwen3 30B A3B', unfiltered: 'partial', think: 'toggle', context: 40960, rates: [12000, 50000] },
  { id: 'Qwen/Qwen3-32B', label: 'Qwen3 32B', think: 'toggle', flash: true, context: 131072, rates: [10000, 28000] },
  { id: 'Qwen/Qwen3.6-27B', label: 'Qwen 3.6 27B', unfiltered: 'full', vision: true, think: 'toggle', context: 262144, rates: [32000, 320000] },
  { id: 'Qwen/Qwen3.8-A95B', label: 'Qwen 3.8 A95B', unfiltered: 'full', think: 'always', context: 262144, rates: [200000, 600000] },
  { id: 'deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2', unfiltered: 'full', think: 'toggle', context: 131072, rates: [26000, 38000] },
  { id: 'deepseek-ai/DeepSeek-R2', label: 'DeepSeek R2', think: 'always', context: 131072, rates: [50000, 215000] },
  { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', label: 'Llama 4 Scout', unfiltered: 'partial', vision: true, think: 'never', context: 327680, rates: [8000, 30000] },
  // No rates and no context: what an older server sends. One model of its
  // family, so it is listed under Other.
  { id: 'moonshotai/Kimi-K3', label: 'Kimi K3', think: 'toggle' },
  { id: 'Gryphe/MythoMax-L2-13b', label: 'MythoMax L2 13B', unfiltered: 'full', think: 'never', context: 4096, rates: [6500, 6500], tools: false },
]

const FLASH = { dailyTokens: 500_000, defaultMaxOutput: 8192, requestSeconds: 240, billingKey: 'k' }

/** The fixture as the model store holds it after a listing. */
export function pickerFixtureModels(): AIModel[] {
  return PICKER_FIXTURE.map((m) => cloudModelRow({
    id: m.id,
    name: m.label,
    provider: 'lu-cloud',
    providerName: 'LU Cloud',
    // What the app budgets with. Always a number, stated or not.
    contextLength: m.context ?? 8192,
    declaredContext: m.context,
    supportsTools: m.tools ?? true,
    supportsVision: m.vision || undefined,
    thinkMode: m.think,
    unfiltered: m.unfiltered,
    flash: m.flash ? FLASH : undefined,
    creditRates: m.rates ? { inputPerMillion: m.rates[0], outputPerMillion: m.rates[1] } : undefined,
  }))
}

/**
 * The models the cloud serves from one fixed upstream and marks
 * `unrestricted`, as its listing sends them: `label` is the neutral name the
 * web app prints, `nativeName` the model's own published name, sent only where
 * the two differ. The provider client keeps the published name
 * (api/providers/openai-provider), so that is what the store holds.
 */
export interface DirectFixtureModel extends PickerFixtureModel {
  nativeName?: string
}

export const DIRECT_FIXTURE: DirectFixtureModel[] = [
  { id: 'direct/v-1.2', label: 'Unfiltered 1.2', nativeName: 'Venice Uncensored 1.2', vision: true, think: 'never', context: 128000, rates: [13637, 61364] },
  { id: 'direct/gemma-4', label: 'Gemma 4 Unfiltered', nativeName: 'Gemma 4 Uncensored', vision: true, think: 'never', context: 256000, rates: [11080, 34091] },
  { id: 'direct/glm-4.7-flash-heretic', label: 'GLM 4.7 Flash Heretic', think: 'toggle', context: 200000, rates: [4773, 27273] },
]

export function directFixtureModels(): AIModel[] {
  return DIRECT_FIXTURE.map((m) => cloudModelRow({
    id: m.id,
    name: m.nativeName ?? m.label,
    provider: 'lu-cloud',
    providerName: 'LU Cloud',
    contextLength: m.context ?? 8192,
    declaredContext: m.context,
    supportsTools: true,
    supportsVision: m.vision || undefined,
    thinkMode: m.think,
    unrestricted: true,
    creditRates: m.rates ? { inputPerMillion: m.rates[0], outputPerMillion: m.rates[1] } : undefined,
  }))
}
