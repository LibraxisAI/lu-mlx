/**
 * Resolve which OpenAI-compatible provider card and wire protocol a model
 * identifier points at so pickers can disambiguate duplicate model names
 * (for example two enabled cards pointing at one endpoint, one on Chat
 * Completions and one on Responses API).
 */
import { displayModelName, isOpenAISlotModel, openaiEntryOfModel } from '../api/providers/model-name'
import type { ApiProtocol, ProviderConfig, ProviderId } from '../api/providers/types'
import type { AIModel } from '../types/models'

export interface ModelProtocolBadge {
  short: string
  long: string
  isResponses: boolean
}

/** Return the owning OpenAI-compat ProviderConfig (slot or additional entry), or null. */
export function resolveModelProviderConfig(
  modelName: string,
  providers: Record<ProviderId, ProviderConfig>,
  openaiEntries?: readonly ProviderConfig[],
): ProviderConfig | null {
  const entryId = openaiEntryOfModel(modelName)
  if (entryId) {
    return openaiEntries?.find((entry) => entry.entryId === entryId) ?? null
  }
  if (isOpenAISlotModel(modelName)) {
    return providers.openai ?? null
  }
  return null
}

/** Return the wire protocol for a non-managed OpenAI-compat model, else null. */
export function resolveModelApiProtocol(
  modelName: string,
  providers: Record<ProviderId, ProviderConfig>,
  openaiEntries?: readonly ProviderConfig[],
): ApiProtocol | null {
  const cfg = resolveModelProviderConfig(modelName, providers, openaiEntries)
  if (!cfg || cfg.managed === true) return null
  return cfg.apiProtocol === 'responses' ? 'responses' : 'chat_completions'
}

/**
 * Badge metadata for a model's API protocol.
 * Responses API always renders its marker; Chat Completions renders only
 * when two cards expose the same display label so non-Responses lists stay quiet.
 */
export function modelProtocolBadge(
  protocol: ApiProtocol | null,
  hasDuplicateDisplayName: boolean,
): ModelProtocolBadge | null {
  if (protocol === 'responses') {
    return {
      short: 'Responses',
      long: 'Responses API (/v1/responses)',
      isResponses: true,
    }
  }
  if (protocol === 'chat_completions' && hasDuplicateDisplayName) {
    return {
      short: 'Chat',
      long: 'Chat Completions (/v1/chat/completions)',
      isResponses: false,
    }
  }
  return null
}

/** Return the set of model display labels shared by >=2 distinct model entries. */
export function duplicateModelDisplayNames(models: readonly AIModel[]): Set<string> {
  const distinctByLabel = new Map<string, Set<string>>()
  for (const model of models) {
    const label =
      ('displayName' in model && typeof model.displayName === 'string' && model.displayName) ||
      displayModelName(model.name)
    let seen = distinctByLabel.get(label)
    if (!seen) {
      seen = new Set<string>()
      distinctByLabel.set(label, seen)
    }
    seen.add(model.name)
  }
  const duplicates = new Set<string>()
  for (const [label, ids] of distinctByLabel.entries()) {
    if (ids.size >= 2) duplicates.add(label)
  }
  return duplicates
}
