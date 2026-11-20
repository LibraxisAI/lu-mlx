/**
 * A hosted chat catalogue for the specs of the Cloud model picker, in the
 * shape the LU Cloud models route answers.
 *
 * The 47 models, their labels, marks, vision, thinking and Flash class follow
 * the web catalogue as of 2026-10-05 (19 models measured "full"). The credit
 * rates are the catalogue prices in credits per one million tokens. The
 * context windows are SAMPLE values for the mock: the app prints whatever the
 * server states and nothing else, which is exactly what the one entry without
 * a window and without rates (Kimi K3, an older server's answer) is here for.
 */
export interface MockChatModel {
  id: string
  label: string
  unfiltered?: 'full' | 'partial'
  flash?: boolean
  vision?: boolean
  think: 'toggle' | 'always' | 'never'
  context?: number
  rates?: [number, number]
}

export const MOCK_CHAT_CATALOGUE: MockChatModel[] = [
  { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'Llama 3.1 8B Turbo', unfiltered: 'partial', flash: true, think: 'never', context: 131072, rates: [2000, 4000] },
  { id: 'inclusionAI/Ling-3.0-flash', label: 'Ling 3.0 flash', unfiltered: 'partial', flash: true, think: 'toggle', context: 131072, rates: [6000, 18000] },
  { id: 'Qwen/Qwen3-30B-A3B', label: 'Qwen3 30B A3B', unfiltered: 'partial', think: 'toggle', context: 40960, rates: [12000, 50000] },
  { id: 'google/gemma-4-26B-A4B-it', label: 'Gemma 4 26B', unfiltered: 'full', flash: true, vision: true, think: 'toggle', context: 131072, rates: [7000, 34000] },
  { id: 'Qwen/Qwen3.6-35B-A3B', label: 'Qwen 3.6 35B A3B', unfiltered: 'partial', vision: true, think: 'toggle', context: 262144, rates: [10000, 95000] },
  { id: 'zai-org/GLM-5.3-Flash', label: 'GLM 5.3 Flash', unfiltered: 'partial', flash: true, vision: true, think: 'always', context: 1048576, rates: [15000, 50000] },
  { id: 'Sao10K/L3-8B-Lunaris-v1-Turbo', label: 'Lunaris 8B', unfiltered: 'full', think: 'never', context: 131072, rates: [4000, 5000] },
  { id: 'Gryphe/MythoMax-L2-13b', label: 'MythoMax 13B', unfiltered: 'full', think: 'never', context: 4096, rates: [40000, 40000] },
  { id: 'NousResearch/Hermes-3-Llama-3.1-70B', label: 'Hermes 3 70B', unfiltered: 'full', think: 'never', context: 131072, rates: [70000, 70000] },
  { id: 'Sao10K/L3.1-70B-Euryale-v2.2', label: 'Euryale 70B', unfiltered: 'partial', think: 'never', context: 131072, rates: [85000, 85000] },
  { id: 'openai/gpt-oss-120b', label: 'gpt-oss 120B', flash: true, think: 'always', context: 131072, rates: [3700, 17000] },
  { id: 'deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2', unfiltered: 'full', think: 'toggle', context: 131072, rates: [26000, 38000] },
  { id: 'NousResearch/Hermes-3-Llama-3.1-405B', label: 'Hermes 3 405B', unfiltered: 'full', think: 'never', context: 131072, rates: [100000, 100000] },
  { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo', label: 'Qwen3 Coder 480B', unfiltered: 'partial', think: 'never', context: 131072, rates: [30000, 100000] },
  { id: 'moonshotai/Kimi-K3', label: 'Kimi K3', unfiltered: 'partial', vision: true, think: 'toggle' },
  { id: 'deepseek-ai/DeepSeek-V3.1', label: 'DeepSeek V3.1', unfiltered: 'full', think: 'toggle', context: 131072, rates: [25000, 95000] },
  { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', label: 'DeepSeek V4 Flash 0731', unfiltered: 'partial', flash: true, think: 'toggle', context: 1048576, rates: [6000, 18000] },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash', vision: true, think: 'always', context: 1048576, rates: [30000, 120000] },
  { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', label: 'DeepSeek V4 Pro 0813', unfiltered: 'partial', think: 'toggle', context: 1048576, rates: [130000, 260000] },
  { id: 'deepseek-ai/DeepSeek-R1-0528', label: 'DeepSeek R1', unfiltered: 'partial', think: 'always', context: 131072, rates: [50000, 215000] },
  { id: 'Qwen/Qwen3-32B', label: 'Qwen3 32B', unfiltered: 'partial', flash: true, think: 'toggle', context: 131072, rates: [8000, 28000] },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', label: 'Qwen3 235B A22B', unfiltered: 'partial', think: 'never', context: 131072, rates: [9000, 55000] },
  { id: 'Qwen/Qwen3.5-9B', label: 'Qwen 3.5 9B', unfiltered: 'full', flash: true, vision: true, think: 'toggle', context: 262144, rates: [10000, 15000] },
  { id: 'Qwen/Qwen3.5-35B-A3B', label: 'Qwen 3.5 35B A3B', unfiltered: 'partial', vision: true, think: 'toggle', context: 262144, rates: [14000, 100000] },
  { id: 'Qwen/Qwen3.5-397B-A17B', label: 'Qwen 3.5 397B A17B', unfiltered: 'partial', vision: true, think: 'toggle', context: 262144, rates: [45000, 300000] },
  { id: 'Qwen/Qwen3.6-27B', label: 'Qwen 3.6 27B', unfiltered: 'full', vision: true, think: 'toggle', context: 262144, rates: [32000, 320000] },
  { id: 'Qwen/Qwen3-VL-30B-A3B-Instruct', label: 'Qwen3 VL 30B', unfiltered: 'partial', vision: true, think: 'never', context: 131072, rates: [15000, 60000] },
  { id: 'Qwen/Qwen3-VL-235B-A22B-Instruct', label: 'Qwen3 VL 235B', unfiltered: 'full', vision: true, think: 'never', context: 131072, rates: [20000, 88000] },
  { id: 'Qwen/Qwen3.8-27B', label: 'Qwen 3.8 27B', unfiltered: 'partial', vision: true, think: 'toggle', context: 262144, rates: [40000, 300000] },
  { id: 'Qwen/Qwen3.8-Max', label: 'Qwen 3.8 Max', think: 'toggle', context: 262144, rates: [165000, 495100] },
  { id: 'Qwen/Qwen3.8-2.4T-A95B', label: 'Qwen 3.8 A95B', unfiltered: 'full', think: 'always', context: 262144, rates: [200000, 600000] },
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', unfiltered: 'full', flash: true, think: 'never', context: 131072, rates: [10000, 32000] },
  { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick', unfiltered: 'full', vision: true, think: 'never', context: 131072, rates: [20000, 80000] },
  { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', label: 'Llama 4 Scout', unfiltered: 'partial', vision: true, think: 'never', context: 131072, rates: [10000, 30000] },
  { id: 'google/gemma-4-31B-it-turbo', label: 'Gemma 4 31B Turbo', unfiltered: 'full', flash: true, vision: true, think: 'toggle', context: 131072, rates: [9000, 34000] },
  { id: 'zai-org/GLM-4.7', label: 'GLM 4.7', unfiltered: 'full', think: 'toggle', context: 131072, rates: [40000, 175000] },
  { id: 'zai-org/GLM-5', label: 'GLM 5', unfiltered: 'partial', think: 'toggle', context: 131072, rates: [60000, 208000] },
  { id: 'zai-org/GLM-5.1', label: 'GLM 5.1', unfiltered: 'partial', think: 'toggle', context: 131072, rates: [105000, 350000] },
  { id: 'zai-org/GLM-5.2', label: 'GLM 5.2', unfiltered: 'partial', think: 'toggle', context: 131072, rates: [75000, 240000] },
  { id: 'zai-org/GLM-5.3', label: 'GLM 5.3', unfiltered: 'partial', think: 'always', context: 131072, rates: [120000, 400000] },
  { id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B', label: 'Nemotron 3 Super 120B', unfiltered: 'partial', think: 'toggle', context: 131072, rates: [8500, 40000] },
  { id: 'openai/gpt-oss-20b', label: 'gpt-oss 20B', flash: true, think: 'always', context: 131072, rates: [3000, 14000] },
  { id: 'moonshotai/Kimi-K2.6', label: 'Kimi K2.6', unfiltered: 'full', vision: true, think: 'toggle', context: 131072, rates: [75000, 350000] },
  { id: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi K2.7 Code', unfiltered: 'full', vision: true, think: 'toggle', context: 131072, rates: [68000, 340000] },
  { id: 'MiniMaxAI/MiniMax-M2.7', label: 'MiniMax M2.7', unfiltered: 'partial', think: 'always', context: 131072, rates: [25000, 100000] },
  { id: 'MiniMaxAI/MiniMax-M3', label: 'MiniMax M3', unfiltered: 'full', vision: true, think: 'toggle', context: 131072, rates: [28000, 110000] },
  { id: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', label: 'Mistral Small 3.2 24B', unfiltered: 'full', flash: true, vision: true, think: 'never', context: 131072, rates: [7500, 20000] },
]

/** The body of GET /api/inference/v1/models for that catalogue. */
export function mockModelsAnswer(tier = 'hosted-pro') {
  return {
    object: 'list',
    tier,
    data: MOCK_CHAT_CATALOGUE.map((m) => ({
      id: m.id,
      object: 'model',
      owned_by: 'lu-labs',
      name: m.label,
      ...(m.context ? { context_length: m.context } : {}),
      max_output_length: 8192,
      input_modalities: m.vision ? ['text', 'image'] : ['text'],
      think: m.think,
      supports_tools: m.id !== 'Gryphe/MythoMax-L2-13b',
      ...(m.unfiltered ? { unfiltered: m.unfiltered } : {}),
      ...(m.flash
        ? { usage_class: 'flash', flash: { sessions_only: true, concurrent_requests: 1, daily_tokens: 2_000_000, default_max_output: 4096, request_seconds: 120 } }
        : {}),
      ...(m.rates ? { credit_rates: { input_per_million: m.rates[0], output_per_million: m.rates[1] } } : {}),
    })),
  }
}
