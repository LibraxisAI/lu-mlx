/**
 * The first use of computer control in a chat waits for the user's yes.
 *
 * Always. No setting, no permission mode, no app that is always allowed, no
 * autonomous session and no earlier yes in another chat stands in for it.
 * The yes holds for that one chat until the app ends. Rust keeps it and
 * begins no session without it (commands/computer/desk/engine.rs), so this
 * file only asks: it cannot let anything through by itself.
 *
 * The question is the card of the tool call in the conversation
 * (ComputerChatPermission). Only the click on Allow lets anything through.
 * Deny is the other button, and in a voice session a spoken "no" or "stop"
 * declines as well (voice-computer.ts): declining is safe.
 */

import { useComputerStore, type ComputerChatAsk } from '../stores/computerStore'
import { answerComputerChat, askComputerChat } from './computer'
import type { AgentRunContext } from './agent-context'
import { holdForStartNote } from '../lib/computer/start-note'

type Run = Pick<AgentRunContext, 'token' | 'conversationId' | 'standing'> | null | undefined

/** What the model reads after a no. The first sentence is the fact, the rest keeps it from asking again. */
export const CHAT_PERMISSION_DENIED =
  'Error: The user did not allow computer control in this chat. Nothing was looked at and nothing was done. Do not call computer control again, and do not do the task another way with other tools. Tell the user so in one sentence.'

/** A call that comes without a run still asks, under a name of its own. */
const NO_RUN_KEY = 'direct'

/** The chat a run belongs to. A run without a conversation is a chat of its own. */
export function computerChatKey(run: Run): string {
  return run?.conversationId || run?.token || NO_RUN_KEY
}

let open: { ask: ComputerChatAsk; resolve: (allow: boolean) => void } | null = null
let counter = 0
/** One question on screen at a time, in the order they were asked. */
let queue: Promise<unknown> = Promise.resolve()
/** Calls of the same chat that arrive while its question is open wait for the same answer. */
const waiting = new Map<string, Promise<string | null>>()
/**
 * Chats Rust has said yes for since this window loaded. It only saves the
 * question to Rust for a chat that is known to be allowed: Rust still begins
 * no session without its own record of the yes.
 */
const known = new Set<string>()
/** The run that got a no, per chat. That run is not asked again; the next request of the user is. */
const denied = new Map<string, string>()

function show(ask: Omit<ComputerChatAsk, 'id'>, signal: AbortSignal | undefined, onShow?: () => void): Promise<boolean> {
  const run = () =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted) return resolve(false)
      counter += 1
      const id = `computer-chat-ask-${counter}`
      const finish = (allow: boolean) => {
        if (open?.ask.id !== id) return
        open = null
        signal?.removeEventListener('abort', onAbort)
        useComputerStore.getState().setChatAsk(null)
        resolve(allow)
      }
      const onAbort = () => finish(false)
      const shown = { ...ask, id }
      open = { ask: shown, resolve: finish }
      signal?.addEventListener('abort', onAbort, { once: true })
      useComputerStore.getState().setChatAsk(shown)
      onShow?.()
    })
  const next = queue.then(run, run)
  queue = next
  return next
}

/**
 * Null when the user has allowed computer control in the chat of this run.
 * Otherwise the sentence the model gets, and nothing may run.
 */
export function ensureComputerChatAllowed(run: Run, signal?: AbortSignal, onShow?: () => void): Promise<string | null> {
  const chatKey = computerChatKey(run)
  if (known.has(chatKey)) return Promise.resolve(null)
  const token = run?.token ?? NO_RUN_KEY
  if (denied.get(chatKey) === token) return Promise.resolve(CHAT_PERMISSION_DENIED)
  const already = waiting.get(chatKey)
  if (already) return already
  const answer = (async (): Promise<string | null> => {
    const asked = await askComputerChat(chatKey)
    if (!asked.ok) return `Error: ${asked.refusal.message}`
    if (asked.allowed) {
      known.add(chatKey)
      return null
    }
    const allow = await show({ chatKey, conversationId: run?.conversationId ?? null, voice: run?.standing === true }, signal, onShow)
    // Rust hears the no as well: it closes the question, so a yes cannot follow it.
    const answered = await answerComputerChat(chatKey, allow)
    if (allow && answered.ok && answered.allowed) {
      known.add(chatKey)
      // The note above the input field says what happens now. A voice session says it aloud instead.
      if (run?.standing !== true) {
        useComputerStore.getState().setStartNote(Date.now())
        await holdForStartNote(signal)
      }
      return null
    }
    // A run that was stopped got no answer from the user: the next one asks.
    if (!signal?.aborted) denied.set(chatKey, token)
    return CHAT_PERMISSION_DENIED
  })().finally(() => waiting.delete(chatKey))
  waiting.set(chatKey, answer)
  return answer
}

/** Is this chat known to be allowed, so that a call can start without a question to Rust? */
export function computerChatKnownAllowed(run: Run): boolean {
  return known.has(computerChatKey(run))
}

/** Rust refused a session for a chat this window took for allowed: ask again next time. */
export function forgetComputerChatAllowed(run: Run): void {
  known.delete(computerChatKey(run))
}

/** Called by the card. An answer for a question that is gone does nothing. */
export function answerComputerChatAsk(id: string, allow: boolean): void {
  if (open?.ask.id === id) open.resolve(allow)
}

/** The user asked for something new in a run that got a no (a voice session is one run): ask again. */
export function forgetComputerChatDenial(run: Run): void {
  const chatKey = computerChatKey(run)
  if (denied.get(chatKey) === (run?.token ?? NO_RUN_KEY)) denied.delete(chatKey)
}

/** Test seam: forget module state between cases. */
export function resetComputerChatForTests(): void {
  open = null
  queue = Promise.resolve()
  waiting.clear()
  denied.clear()
  known.clear()
  useComputerStore.getState().setChatAsk(null)
  useComputerStore.getState().setStartNote(null)
}
