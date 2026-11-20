/**
 * The pause: the user reached for the mouse or the keyboard while LU worked
 * on the screen, or pressed the pause shortcut.
 *
 * Rust holds the pause and refuses everything while it lasts. This file is
 * the conversation around it: it puts the question on screen, lets the call
 * that was refused wait for the answer, and carries what the user typed
 * while paused to the model.
 *
 * Two ways out, both the user's: `answerComputerPause(true)` (let it
 * continue) and `answerComputerPause(false)` (take over, which ends the
 * task like Stop). There is no timer. A stop from anywhere else (the Stop
 * shortcut, the chat's own Stop) ends the wait as "take over".
 */

import { answerComputerTakeover } from '../../api/computer'
import { useComputerStore } from '../../stores/computerStore'

type Waiter = (go: boolean) => void

let waiters: Waiter[] = []
let notes: string[] = []

/** The longest instruction the paused view passes on. */
export const MAX_PAUSE_NOTE_CHARS = 500

/** The question is on screen from now on. Safe to call twice. */
export function noteComputerPaused(): void {
  useComputerStore.getState().setPaused(true)
}

function settle(go: boolean): void {
  useComputerStore.getState().setPaused(false)
  const waiting = waiters
  waiters = []
  for (const resolve of waiting) resolve(go)
}

/**
 * Wait for the user's answer. True: go on. False: the user took over, or
 * the run was stopped or cancelled meanwhile.
 */
export function waitForPauseAnswer(signal?: AbortSignal): Promise<boolean> {
  noteComputerPaused()
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false)
    const done: Waiter = (go) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(go)
    }
    const onAbort = () => {
      waiters = waiters.filter((w) => w !== done)
      done(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiters.push(done)
  })
}

/**
 * The user's answer, from the paused view. `note` is what they typed for the
 * model; it travels with "let it continue" only.
 */
export async function answerComputerPause(go: boolean, note?: string): Promise<void> {
  const text = go ? (note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PAUSE_NOTE_CHARS) : ''
  // Rust first: until it has lifted the pause, a call that went on here
  // would only be refused again.
  const answered = await answerComputerTakeover(go).catch(() => null)
  if (go && (!answered || !answered.ok || answered.paused)) {
    // The pause still holds, so the question stays. Nothing was continued.
    return
  }
  if (text) notes.push(text)
  settle(go)
}

/** A stop ended the session while the question was open. */
export function endComputerPause(): void {
  if (useComputerStore.getState().paused || waiters.length > 0) settle(false)
}

/** What the user typed while paused, once. Null when there is nothing. */
export function takePauseNote(): string | null {
  if (notes.length === 0) return null
  const text = notes.join(' ')
  notes = []
  return text
}

/** Test seam. */
export function resetComputerPauseForTests(): void {
  waiters = []
  notes = []
}
