// Where a voice session and computer control meet.
//
// A voice session can hand a task on the screen to computer control. This
// file is everything the two say to each other: a question on screen is also
// asked aloud, a spoken yes or no answers it where that is allowed
// (lib/computer/spoken.ts), a spoken "stop" or "wait" pauses the task the way
// the pause shortcut does, and a task ends when the switches at the top of
// Voice take the screen away from the session.
//
// The first use of computer control in a session stops at a card on the voice
// surface (computer-chat.ts). Only the click on Allow lets it through. The
// voice loop is told about the card as a question that needs the click, so
// "yes" is answered with one sentence and never reaches the model, and "no"
// or "stop" declines.
//
// No connection of its own: the session hands in how to send a message to
// the voice loop.

import { computerControlBusy, computerRunOrigin, pauseComputerControl, stopComputerControl } from './computer-use'
import { answerComputerChatAsk } from './computer-chat'
import { answerComputerPrompt } from '../lib/computer/prompts'
import { COMPUTER_TASK_TOOL_NAME } from '../lib/computer/prompt'
import { spokenAnswer, spokenQuestion } from '../lib/computer/spoken'
import { toolInScope, type VoiceWork } from '../lib/voice/work-scope'
import { useComputerStore } from '../stores/computerStore'

type Send = (kind: string, data: Record<string, unknown>) => void

/** What the voice says when the card "Allow computer control in this chat?" opens. */
export const CHAT_QUESTION = 'Before I use this computer, I need your permission. Please click Allow or Deny on the screen.'

/** The card of this voice session, when it is open. The card of a chat is not the session's. */
function voiceChatAsk() {
  const ask = useComputerStore.getState().chatAsk
  return ask?.voice ? ask : null
}

/**
 * Tell the voice loop what computer control is doing: whether a task runs,
 * and which question is open. Returns the way to stop telling.
 *
 * While the task is paused no question is open for the voice: the paused
 * view is answered with a click and nothing else, and the question under it
 * is not on screen. Once the user lets LU continue, the question that still
 * waits is asked aloud again.
 */
export function announceComputerControl(send: Send, taskStarted: () => void): () => void {
  let asked: string | null = null
  let tasking = false
  const sync = () => {
    const state = useComputerStore.getState()
    const running = state.task !== null
    if (running !== tasking) {
      tasking = running
      send('task', { active: running })
      if (running) taskStarted()
    }
    const prompt = state.paused ? null : state.prompt
    const card = voiceChatAsk()
    // A question of a running session first. The card comes before any session.
    const open = prompt
      ? { id: prompt.id, ...spokenQuestion(prompt) }
      : card ? { id: card.id, text: CHAT_QUESTION, voice: false } : null
    if (open && open.id !== asked) {
      // One question at a time is open for the voice.
      if (asked) send('question-closed', { id: asked })
      asked = open.id
      send('question', { id: open.id, text: open.text, voice: open.voice })
    } else if (!open && asked) {
      send('question-closed', { id: asked })
      asked = null
    }
  }
  const off = useComputerStore.subscribe(sync)
  sync()
  return off
}

/**
 * "Stop" or "wait" was said while a screen task ran. The task pauses, as
 * with the pause shortcut, and the user chooses in the paused view. Where
 * there is nothing to pause, the word stops computer control instead.
 */
export function voiceSaidStop(): void {
  const card = voiceChatAsk()
  if (card) {
    // Nothing runs yet. The word declines, and there is nothing else to stop.
    answerComputerChatAsk(card.id, false)
    return
  }
  void pauseComputerControl()
}

/** A spoken yes or no for the question with this id. Not while paused, and not for a question that needs the click. A no also declines the card of the session. */
export function voiceAnswered(id: unknown, answer: 'yes' | 'no'): void {
  const card = voiceChatAsk()
  if (card && card.id === id) {
    // Declining is safe. Allowing takes the click, whatever was heard.
    if (answer === 'no') answerComputerChatAsk(card.id, false)
    return
  }
  const state = useComputerStore.getState()
  const prompt = state.prompt
  if (!prompt || prompt.id !== id || state.paused) return
  const meant = spokenAnswer(prompt, answer)
  if (meant !== null) answerComputerPrompt(prompt.id, meant)
}

/**
 * The switches of the session no longer allow the screen (Agent off, or
 * "Workspace only"), and a screen task of this session is still going: it
 * ends here, like Stop. True when something was ended.
 */
export async function endScreenWorkOutOfScope(work: VoiceWork): Promise<boolean> {
  if (toolInScope(COMPUTER_TASK_TOOL_NAME, work)) return false
  if (!computerRunOrigin().voice || !computerControlBusy()) return false
  await stopComputerControl()
  return true
}
