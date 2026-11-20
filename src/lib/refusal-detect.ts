import { UNFILTERED_MARK_LABEL } from './unfiltered-mark'
import type { Conversation, Message } from '../types/chat'

/**
 * Did the model decline, and where does the chat say so.
 *
 * Measured 2026-10-05 (lu-305/mail/TEST-VERWEIGERUNG-2026-10-05.md): once a
 * refusal stands in the history, models that would have answered copy it in
 * the same chat. The way out is a new chat, so the app says that under the
 * refusing answer, in Cloud and in local chat alike, and offers the new chat
 * right there.
 *
 * A refusal is a SHORT answer that OPENS with a refusal phrase. Both halves
 * are needed: a long answer that starts with "I can't" usually goes on to do
 * the work, and a story may hold "I cannot help you" in the middle of a
 * dialogue. Neither is a refusal of the request.
 */

/** The notice under the refusing answer. Agreed word for word with the web
 *  app; the mark it names is the measured one of the model picker
 *  (ModelRowMarks), read from the one place that holds its word. */
export const REFUSAL_NOTICE =
  'This model declined. A refusal stays in the chat history, and other models tend to copy it. ' +
  `Start a new chat and pick a model marked ${UNFILTERED_MARK_LABEL}.`

/** Below this many words an answer counts as short. */
const SHORT_ANSWER_WORDS = 60

/** How much of the answer counts as its opening. Roughly the first sentence
 *  or two, so "I'm sorry, but I cannot create that" is still caught behind
 *  its apology. */
const OPENING_CHARS = 160

/** Phrases that open a refusal when they are the first words of the answer. */
const OPENS_WITH = new RegExp(
  '^(?:' + [
    // "I can't wait to show you" and "I can't believe it" are not refusals.
    "i (?:can't|cannot|can not|won't|will not)\\b(?! (?:wait|believe|thank|stress|emphasize|overstate|say enough|help but|get enough))",
    "(?:i'm|i am) (?:unable|not able|not comfortable|sorry,? but)\\b",
    'i must decline\\b',
    '(?:sorry|i apologi[sz]e|unfortunately),? (?:but )?i ' +
      "(?:can't|cannot|can not|won't|will not|am unable|am not able|am not comfortable|must decline)\\b",
  ].join('|') + ')',
)

/** Phrases that mark a refusal anywhere in the opening, e.g. behind "As an AI". */
const OPENING_HOLDS = new RegExp(
  [
    "\\b(?:cannot|can't|can not|unable to|won't|will not) " +
      '(?:help|assist|create|continue|engage|fulfill|comply|write|generate|produce|provide)\\b(?! but)',
    '\\bnot comfortable\\b',
    '\\bi must decline\\b',
  ].join('|'),
)

/** The visible text of an answer: reasoning the model sent inline is not part
 *  of what it said. Covers a closed block, a block that never closed, and a
 *  reply that starts in the middle of a thought and only sends the closing tag
 *  (lib/hermes-stream). */
function withoutThinking(content: string): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
  const strayClose = text.toLowerCase().lastIndexOf('</think>')
  if (strayClose !== -1) text = text.slice(strayClose + '</think>'.length)
  const strayOpen = text.toLowerCase().indexOf('<think>')
  if (strayOpen !== -1) text = text.slice(0, strayOpen)
  return text
}

/**
 * Pure: does this finished answer text read as a refusal?
 * Short (under 60 words without `<think>` blocks) AND a refusal phrase in its
 * opening.
 */
export function looksLikeRefusal(content: string): boolean {
  const text = withoutThinking(content).trim()
  if (!text) return false
  if (text.split(/\s+/).length >= SHORT_ANSWER_WORDS) return false
  const opening = text
    .slice(0, OPENING_CHARS)
    .toLowerCase()
    // Typographic apostrophes, as most hosted models send them.
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    // Leading quote marks, markdown emphasis and the like.
    .replace(/^[^a-z]+/, '')
  return OPENS_WITH.test(opening) || OPENING_HOLDS.test(opening)
}

/** Message objects are replaced, never mutated (chatStore), so the verdict of
 *  one object never changes and a streaming frame costs one lookup per
 *  message it did not touch. */
const verdicts = new WeakMap<Message, boolean>()

/** Is this message a plain answer of the model? Tool results, app notices,
 *  hidden history rows and the app's own error sentences are not, and neither
 *  is an answer of a turn that ran tools: "I can't find that file" after a
 *  failed read is a report, not a refusal. */
function isModelAnswer(m: Message): boolean {
  if (m.role !== 'assistant' || m.hidden || m.notice) return false
  if (m.tool_calls?.length || m.toolCallSummary) return false
  if (m.agentBlocks?.some((b) => b.toolCall || b.toolCalls?.length)) return false
  return !/^\s*error:/i.test(m.content || '')
}

/**
 * Is this a chat in which the notice may appear at all? Only the plain chat,
 * hosted or local. In Agent mode and in Code a short "I can't ..." is usually
 * about a file or a command, and in a group chat one model's short line is
 * often an answer to another model, so the phrase proves nothing there. Code
 * has its own transcript and never comes through here; the check on `mode`
 * holds the line in case it ever does.
 */
export function refusalNoticeApplies(
  conversation: Pick<Conversation, 'mode' | 'groupModels'>,
  agentModeActive: boolean,
): boolean {
  if (agentModeActive) return false
  if (conversation.mode === 'codex' || conversation.mode === 'openclaw') return false
  return !conversation.groupModels?.length
}

function declined(m: Message): boolean {
  let verdict = verdicts.get(m)
  if (verdict === undefined) {
    verdict = isModelAnswer(m) && looksLikeRefusal(m.content || '')
    verdicts.set(m, verdict)
  }
  return verdict
}

/**
 * The id of the LATEST refusing answer of a chat, or null. The notice stands
 * there and nowhere else: one line per chat says it, a second one further up
 * would say nothing new.
 *
 * `streamingId` is the answer still being written. A refusal is judged on a
 * finished answer only, since every long answer is a short one for a moment.
 */
export function latestRefusalId(messages: readonly Message[], streamingId?: string | null): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.id === streamingId) continue
    if (declined(m)) return m.id
  }
  return null
}
