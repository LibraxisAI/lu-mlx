/**
 * Questions computer control asks the user, one at a time.
 *
 * The tool waits on a promise; the question (ComputerQuestion) shows what is
 * in the store and answers by id. Escape, a stop and an
 * aborted run all count as "no".
 */

import { useComputerStore, type ComputerPrompt } from '../../stores/computerStore'
import type { ComputerApp, ComputerPermission } from '../../api/computer'

export type AppAnswer = 'once' | 'session' | 'always' | 'deny'

type Resolver = (answer: AppAnswer | boolean) => void

let pending: { id: string; resolve: Resolver; refuse: AppAnswer | boolean } | null = null
let counter = 0
let queue: Promise<unknown> = Promise.resolve()

function ask<T extends AppAnswer | boolean>(
  build: (id: string) => ComputerPrompt,
  refuse: T,
  signal?: AbortSignal,
  onShow?: () => void,
): Promise<T> {
  const run = () =>
    new Promise<T>((resolve) => {
      if (signal?.aborted) return resolve(refuse)
      counter += 1
      const id = `computer-prompt-${counter}`
      const finish = (answer: AppAnswer | boolean) => {
        if (pending?.id !== id) return
        pending = null
        signal?.removeEventListener('abort', onAbort)
        useComputerStore.getState().setPrompt(null)
        resolve(answer as T)
      }
      const onAbort = () => finish(refuse)
      pending = { id, resolve: finish, refuse }
      signal?.addEventListener('abort', onAbort, { once: true })
      useComputerStore.getState().setPrompt(build(id))
      onShow?.()
    })
  // One question on screen at a time, in the order they were asked.
  const next = queue.then(run, run)
  queue = next
  return next
}

/** "May LU control this app?" */
export function askAppApproval(app: ComputerApp, windowTitle: string | null, signal?: AbortSignal, onShow?: () => void): Promise<AppAnswer> {
  return ask<AppAnswer>((id) => ({ kind: 'app', id, app, windowTitle }), 'deny', signal, onShow)
}

/** "Run this one action?" */
export function askActionConfirmation(
  q: { app: ComputerApp | null; description: string; reason: string | null; sensitive: boolean },
  signal?: AbortSignal,
  onShow?: () => void,
): Promise<boolean> {
  return ask<boolean>((id) => ({ kind: 'confirm', id, ...q }), false, signal, onShow)
}

/**
 * "The operating system has to allow this first." True once the permission is
 * granted (the question watches for it), false when the user closes it.
 */
export function askPermission(permission: ComputerPermission, signal?: AbortSignal, onShow?: () => void): Promise<boolean> {
  return ask<boolean>((id) => ({ kind: 'permission', id, permission }), false, signal, onShow)
}

/** Called by the question. An answer for a question that is gone does nothing. */
export function answerComputerPrompt(id: string, answer: AppAnswer | boolean): void {
  if (pending?.id === id) pending.resolve(answer)
}

/** Refuse whatever is being asked right now (Stop was pressed). */
export function refusePendingComputerPrompt(): void {
  if (pending) pending.resolve(pending.refuse)
}
