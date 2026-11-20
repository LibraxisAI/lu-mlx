// The "Create" switch in the chat.
//
// The desktop twin of the web app. The texts the model
// and the customer read are the web's, word for word (web-parity.test.ts
// compares them). The rule is the web's too, with one difference in where the
// facts come from: the web carries its chat catalogue in the bundle, the
// desktop carries none. Whether a model gets Create in chat and how large its
// window is are read from what the server says in the model list
// (create_in_chat, context_length). No answer means no.
//
// - On: create_options and create_order ride along with every message, in
//   plain chat and in Agent mode. No word filter; the model decides in
//   context. An overeager model costs nothing, every order needs the
//   customer's approval.
// - Off: no Create tools, and for ordinary conversation not a word in the
//   system prompt. One exception, for exactly one turn: when the customer's
//   message plainly asks for a medium (media-wish.ts), a note tells the model
//   that it cannot make one here and where the switch is.
// - A model the server does not release for Create in chat, or whose window
//   does not carry the tools, gets the switch off and greyed, with one short
//   line in the Plugins menu. The tools do not go along then.
//
// Cloud mode only, and only for an account the server has released
// (chat-release.ts). In Local mode there is no switch and no text: the local
// chat makes media with its own tools (image_generate, video_generate), and
// nothing about it changes. Without the release, the cloud chat is the one
// that shipped before: every function here takes `live` = Cloud mode AND
// release (createChatLive).

import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayModelName, getProviderIdFromModel } from '../../api/providers/registry'
import { resolveToolSupport } from '../tool-support'
import { mediaWish } from './media-wish'
import { createChatReleasedHere } from './chat-release'
import { CREATE_TOOL_NAMES, isCreateToolName } from './chat-origin'

export { CREATE_TOOL_NAMES, isCreateToolName }

/** Is the app in Cloud mode right now? */
export function cloudModeHere(): boolean {
  return useSettingsStore.getState().settings.appMode === 'cloud'
}

/** Is there Create in chat here: Cloud mode, and the server has released it
 *  for this account? Without both the chat is the one that shipped before. */
export function createChatLive(cloudMode = cloudModeHere(), released = createChatReleasedHere()): boolean {
  return cloudMode && released
}

/**
 * What the two tools take up in the window, in tokens: their descriptions, a
 * typical overview and the largest detail from create_options. Measured on the
 * web (lib/create/__tests__/tool-budget.test.ts there); the number is the
 * web's, and web-parity.test.ts holds it to it.
 */
export const CREATE_TOOLS_TOKENS = 4_566

/** At most this share of the window for the Create tools. */
export const CREATE_TOOLS_WINDOW_SHARE = 0.5

export interface CreateSupport {
  /** Is there a switch here at all (Cloud mode and release)? */
  shown: boolean
  /** Can the active model carry the tools? */
  available: boolean
  /** One short line next to the greyed switch. Empty when available. */
  reason: string
}

type ModelRow = {
  name: string
  type?: string
  contextLength?: number
  declaredContext?: number
  supportsTools?: boolean
  createInChat?: boolean
}

const rowOf = (activeModel: string | null, models: ReadonlyArray<ModelRow>) =>
  activeModel ? models.find((m) => m.name === activeModel) : undefined

/** The window the server states for the active model, or null. A stated
 *  window wins over a table value. */
export function servedWindowOf(
  activeModel: string | null,
  models: ReadonlyArray<ModelRow> = useModelStore.getState().models,
): number | null {
  const row = rowOf(activeModel, models)
  const n = row?.declaredContext ?? row?.contextLength
  return typeof n === 'number' && n > 0 ? n : null
}

/** The line next to the greyed switch for a model the catalogue does not
 *  release for Create in chat. */
export const CREATE_MODEL_REASON = 'Not available with this model.'

/** Does the server release the active model for Create in chat? Only what the
 *  model list says (create_in_chat) counts. A model of another provider, a
 *  server that does not send the field yet, a row that is not there: no. */
export function createInChatOf(
  activeModel: string | null,
  models: ReadonlyArray<ModelRow> = useModelStore.getState().models,
): boolean {
  if (!activeModel || getProviderIdFromModel(activeModel) !== 'lu-cloud') return false
  return rowOf(activeModel, models)?.createInChat === true
}

/** Can the active model call tools at all, by what its row says? */
function toolsOf(activeModel: string, models: ReadonlyArray<ModelRow>): boolean {
  const row = rowOf(activeModel, models)
  return resolveToolSupport({ name: activeModel, supportsTools: row?.type === 'text' || row?.type === undefined ? row?.supportsTools : undefined }) !== 'none'
}

/** Is there a switch, is the active model released, and does its window carry
 *  the tools? A model whose window is unknown does not carry them (the safe
 *  side). */
export function createSupport(
  activeModel: string | null,
  live = createChatLive(),
  servedWindow: number | null = servedWindowOf(activeModel),
  released: boolean = createInChatOf(activeModel),
  models: ReadonlyArray<ModelRow> = useModelStore.getState().models,
): CreateSupport {
  if (!live) return { shown: false, available: false, reason: '' }
  if (!activeModel) return { shown: true, available: false, reason: 'Pick a model first.' }
  if (!toolsOf(activeModel, models)) {
    return { shown: true, available: false, reason: 'This model cannot call tools. Pick another one to use Create.' }
  }
  if (!released) return { shown: true, available: false, reason: CREATE_MODEL_REASON }
  const allowed = servedWindow ? Math.floor(servedWindow * CREATE_TOOLS_WINDOW_SHARE) : 0
  if (CREATE_TOOLS_TOKENS > allowed) {
    const size = servedWindow ? ` (${Math.round(servedWindow / 1024)}k)` : ''
    return {
      shown: true,
      available: false,
      reason: `${displayModelName(activeModel)} has too small a context window${size} for Create. Pick a larger model to use it.`,
    }
  }
  return { shown: true, available: true, reason: '' }
}

/** Do the Create tools go along in this turn? */
export function createActive(
  settings: { createEnabled?: boolean },
  activeModel: string | null,
  live = createChatLive(),
  servedWindow: number | null = servedWindowOf(activeModel),
  released: boolean = createInChatOf(activeModel),
): boolean {
  return settings.createEnabled === true && createSupport(activeModel, live, servedWindow, released).available
}

// ── System prompt ────────────────────────────────────────────────────────
//
// Short, because it counts towards the token budget. English like every text
// to the model. The four texts below are the web's, character for character.

/** Create an: der Absatz. */
export const CREATE_ON_PARAGRAPH =
  'Create is on: you can make images, clips, music and voice for the customer with the tools create_options and create_order. '
  + 'If the request is unclear or an input is missing, ask first. If it is clear, do not ask which model or setting to use: the defaults are fine and the order card is the question. '
  + 'Call create_options before create_order, and tell the customer the price create_order returns. '
  + 'An order exists only once create_order says it is waiting; never describe one it did not return. '
  + 'Use only handles that create_options or an earlier result gave you; never invent one. '
  + 'Nothing runs until the customer approves the order, so never say something is being made or is ready before that. '
  + 'If the customer is just talking, just talk.'

/** Create ist eingeschaltet, geht mit diesem Modell aber nicht: genau ein Satz. */
export const CREATE_UNAVAILABLE_SENTENCE =
  'You cannot make images, clips, music or voice in this chat; if the customer asks for them, tell them to pick another model and switch on Create under Plugins.'

/** Create ist aus, und die Nachricht des Kunden bittet um ein Medium. Als
 *  Bedingung geschrieben: irrt die Erkennung, antwortet das Modell normal. */
export const CREATE_OFF_HINT =
  'If the customer is asking you to make or edit an image, clip, music or voice: you cannot do that in this chat right now, so do not pretend to. '
  + 'Tell them in their language to switch on Create under Plugins and ask again; then you can make it here. Otherwise ignore this note.'

/** Dasselbe bei einem Modell, mit dem Create nicht geht: einschalten hilft
 *  dort nicht, der Kunde braucht ein anderes Modell. */
export const CREATE_OFF_BLOCKED_HINT =
  'If the customer is asking you to make or edit an image, clip, music or voice: you cannot do that in this chat, and Create does not work with this model, so do not pretend to. '
  + 'Tell them in their language to pick another model first and then switch on Create under Plugins. Otherwise ignore this note.'

/** The Create part of the system prompt. Outside Cloud mode and without the
 *  account's release always empty.
 *  With Create on: the paragraph, or the one sentence for a model Create does
 *  not work with. With Create off: empty, unless `userText` (the customer's
 *  message in this turn) plainly asks for a medium; then the note that points
 *  at the switch, for this turn only. */
export function createSystemText(
  settings: { createEnabled?: boolean },
  activeModel: string | null,
  live = createChatLive(),
  userText = '',
): string {
  const support = createSupport(activeModel, live)
  if (!support.shown) return ''
  if (settings.createEnabled === true) return support.available ? CREATE_ON_PARAGRAPH : CREATE_UNAVAILABLE_SENTENCE
  if (!activeModel || !mediaWish(userText)) return ''
  return support.available ? CREATE_OFF_HINT : CREATE_OFF_BLOCKED_HINT
}

/** Appends the Create part to a system prompt. */
export function withCreateText(systemPrompt: string, createText: string): string {
  if (!createText) return systemPrompt
  return systemPrompt ? `${systemPrompt}\n\n${createText}` : createText
}
