// Which model looks at the screen during a `computer_task`, and how it is
// asked.
//
// The brain of a conversation (and above all of a voice session) gets tool
// results as text, and many chat models cannot see images at all. So the
// looking is done by an executor model: it gets the screenshot and names one
// action. Three places it can come from, all through the provider system the
// chat uses:
//
//   - the chat model itself, when it can see images (the default)
//   - a local model in Ollama or the LU Engine, for example one trained for
//     screens
//   - a model of the LU Cloud catalog that the server lists with image input
//
// Nothing here knows a model by name. What can see is what the app's own
// model list says can see.

import { getProviderForModel, getProviderIdFromModel, displayModelName } from './providers'
import type { ChatMessage } from './providers/types'
import { modelCanSee } from './vision-feedback'
import { declaredVision, modelNameSuggestsVision } from '../lib/model-compatibility'
import { GOAL_CHECK_PROMPT, GOAL_CHECK_SCHEMA, executorFormatFor, executorSchema, parseGoalCheck } from '../lib/computer/executor-format'
import type { ExecutorFormat } from '../lib/computer/executor-format'
import { useComputerStore } from '../stores/computerStore'
import { useModelStore } from '../stores/modelStore'
import { listBundledModels } from './engine'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../lib/lmstudio-match'
import type { AIModel } from '../types/models'

export interface ExecutorCandidate {
  /** The name the model store knows it by. */
  name: string
  label: string
  where: 'cloud' | 'local'
}

export interface ResolvedExecutor {
  model: string
  label: string
  format: ExecutorFormat
  /**
   * False for a chat model without image input. Such a model can still work
   * where the system reports the elements of a window (the interface tree):
   * it gets that list instead of the picture. The task decides whether the
   * list is there.
   */
  sees: boolean
}

/**
 * A model without image input on a system that does not list the buttons and
 * fields of a window (macOS, Linux). One sentence, and nothing is offered:
 * what the model can do is not a question to the user.
 */
export const NO_EXECUTOR_ERROR =
  'Error: This model cannot see the screen on this system. Tell the user so in one sentence, and do not try again.'

const bareId = (name: string): string => (name.includes('::') ? name.split('::').slice(1).join('::') : name)

/**
 * The models the settings offer: text models the list itself says can see.
 * A cloud row counts only on the server's own word (its input modalities);
 * a local row also by its family name, because Ollama states the capability
 * only when asked per model.
 */
export function executorCandidates(models: readonly AIModel[]): ExecutorCandidate[] {
  const out: ExecutorCandidate[] = []
  for (const model of models) {
    if (model.type !== 'text') continue
    const cloud = getProviderIdFromModel(model.name) === 'lu-cloud'
    const declared = declaredVision(model)
    const sees = cloud ? declared === true : declared ?? modelNameSuggestsVision(model.name)
    if (!sees) continue
    out.push({ name: model.name, label: displayModelName(model.name), where: cloud ? 'cloud' : 'local' })
  }
  return out
}

/**
 * Can this model be handed a screenshot right now? This is the one place
 * that decides how computer control runs: with the picture, or from the list
 * of buttons and fields. Nobody is asked, and nothing is offered.
 *
 * A model of the LU Engine sees only while it is loaded with its image part.
 * The part can lie next to the model and still not be loaded: the card had
 * no room for it, or it arrived after the model was started. So the engine
 * is asked now, and its word counts over what the model list remembered.
 */
export async function modelSeesImages(name: string): Promise<boolean> {
  const meta = useModelStore.getState().models.find((m) => m.name === name)
  const path = meta && isBuiltinEngineEntry(meta as InstalledModelLike) ? (meta as { path?: unknown }).path : null
  if (typeof path === 'string') {
    const now = (await listBundledModels().catch(() => null))?.find((m) => m.path === path)
    if (now && typeof now.vision === 'boolean') return now.vision
  }
  return modelCanSee(bareId(name), getProviderIdFromModel(name), declaredVision(meta))
}

/**
 * The executor for a task that starts now: the user's choice, or the chat
 * model. The chat model is the default also when it cannot see: one model in
 * memory answers in a third of the time two models take that have to swap
 * (measured on a 12 GB card, 06.10.2026). Null only without any model.
 */
export async function resolveExecutor(): Promise<ResolvedExecutor | null> {
  const chosen = useComputerStore.getState().executorModel
  const { activeModel, models } = useModelStore.getState()
  // A choice that is gone from the list (a deleted download) falls back to
  // the chat model instead of failing on a name nobody can load.
  const pick = chosen && models.some((m) => m.name === chosen) ? chosen : null
  const model = pick ?? activeModel
  if (!model) return null
  // Asked for every model, also one the user picked: a picked local model can be loaded without its image part.
  const sees = await modelSeesImages(model).catch(() => false)
  return { model, label: displayModelName(model), format: executorFormatFor(bareId(model)), sees }
}

/** How long one look may take before the task gives up on it. */
export const EXECUTOR_ANSWER_TIMEOUT_MS = 120_000
// One sentence of thought and one action. 500 let a model that lost its way
// write for 14 seconds before it was cut (box, 09.10.2026).
const MAX_ANSWER_TOKENS = 250

/** One question to the executor: the conversation so far in, its answer text out. */
export async function askExecutor(executor: ResolvedExecutor, messages: ChatMessage[], signal?: AbortSignal, elements = true): Promise<string> {
  const { provider, modelId } = getProviderForModel(executor.model)
  const timeout = AbortSignal.timeout(EXECUTOR_ANSWER_TIMEOUT_MS)
  const answer = await provider.chatWithTools(modelId, messages, [], {
    // Holo is trained for 0.8 in a loop; a general model clicks most
    // reliably without sampling noise.
    temperature: executor.format === 'holo' ? 0.8 : 0,
    maxTokens: MAX_ANSWER_TOKENS,
    maxTokensIsDefault: true,
    // The step itself carries a one line thought. Reasoning on top of it
    // costs seconds per step.
    thinking: false,
    jsonSchema: executorSchema(executor.format, elements),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  return answer.content
}

/** What a goal check is shown: the goal, what was done, and the screen as it is now. */
export interface GoalCheckInput {
  goal: string
  /** One line per action that was taken. */
  actions: string[]
  /** The screen in words, already marked as data. */
  screen: string
  frame: { data: string; mimeType: string } | null
}

/**
 * Ask the model that looks at the screen whether the goal is reached. A
 * screen model that keeps clicking after it is done never says so itself;
 * this one question lets the task end as finished instead of as stopped.
 * Null when there is no clear answer.
 */
export async function checkGoalReached(executor: ResolvedExecutor, input: GoalCheckInput, signal?: AbortSignal): Promise<{ reached: boolean; summary: string } | null> {
  const { provider, modelId } = getProviderForModel(executor.model)
  const timeout = AbortSignal.timeout(EXECUTOR_ANSWER_TIMEOUT_MS)
  const lines = [`Goal: ${input.goal}`, input.actions.length > 0 ? `Actions taken:\n${input.actions.join('\n')}` : 'No action was taken.', `<observation>\n${input.screen}\n</observation>`]
  if (!input.frame || !executor.sees) lines.push('There is no picture. Decide from the text above.')
  lines.push('Is the goal reached?')
  const question: ChatMessage = { role: 'user', content: lines.join('\n') }
  if (input.frame && executor.sees) question.images = [input.frame]
  const answer = await provider.chatWithTools(modelId, [{ role: 'system', content: GOAL_CHECK_PROMPT }, question], [], {
    temperature: 0,
    maxTokens: 200,
    maxTokensIsDefault: true,
    thinking: false,
    jsonSchema: GOAL_CHECK_SCHEMA,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  return parseGoalCheck(answer.content)
}
