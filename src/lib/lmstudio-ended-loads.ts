/**
 * The LM Studio loads the app ended while LM Studio may still be working on
 * them.
 *
 * Ending a load means ending the `lms` process that asked for it. LM Studio
 * does not take that as the end of the load: seen on 11.10.2026 with LM Studio
 * 0.4.12, a load whose `lms` was gone within half a second ran on for 26 to
 * 46 s, and the model then sat in memory, 6 GB of it, with the picker showing
 * "Off". So a load the app ended is written down here, and api/lmstudio.ts
 * watches LM Studio until the model is really not there: it sends one unload
 * while LM Studio is still loading (which ended the load on that version),
 * unloads the model once LM Studio reports it loaded, or sees that the load
 * never arrived.
 *
 * What is written down, and what is not:
 *
 *   - Only a load the app started and then ended, by a Cancel or at its time
 *     limit. A model somebody loaded in LM Studio is never in this list and is
 *     never unloaded from it.
 *   - Asking for the same model again takes it off the list: what the person
 *     wants now outranks what they cancelled before (`claimEndedLmStudioLoad`).
 *     An unload that is already on its way is waited for first, so it cannot
 *     hit the new load.
 *   - Loading another model, closing the picker and switching the chat to
 *     another backend change nothing. The memory is still LM Studio's to free.
 *   - The list lives as long as the app does. Quitting the app in these
 *     seconds leaves the model loaded in LM Studio.
 *
 * This module is the list and nothing else, so the picker can show it without
 * pulling in the bridge.
 */
import { useSyncExternalStore } from 'react'

export interface EndedLmStudioLoad {
  /** The key `lms` loads by, which is also the id LM Studio lists the instance under. */
  model: string
  /** The context window the load asked for, null for LM Studio's default. */
  contextLength: number | null
  endedAt: number
  /** How many looks in a row found the model neither loaded nor loading. */
  quietLooks: number
  /** Whether the one unload that may end a load in mid-flight has been sent. */
  unloadedWhileLoading: boolean
  /** The unload that is on its way to LM Studio for this load right now. */
  unloading: Promise<unknown> | null
}

export interface EndedLmStudioLoads {
  /** Models whose ended load LM Studio has not let go of yet. */
  ending: ReadonlySet<string>
  /** Counts the loads that were seen to be gone. See `lmStudioWentAfter`. */
  goneMark: number
  /** Models the watch gave up on without seeing them gone. */
  unconfirmed: readonly string[]
}

const ended = new Map<string, EndedLmStudioLoad>()
let unconfirmed: string[] = []
// When each model was last seen to be gone, as a count that only grows.
const wentAt = new Map<string, number>()
let goneMark = 0
let view: EndedLmStudioLoads = { ending: new Set(), goneMark, unconfirmed }
const listeners = new Set<() => void>()

function publish(): void {
  view = { ending: new Set(ended.keys()), goneMark, unconfirmed }
  for (const listener of listeners) listener()
}

/** The app ended its own load of `model`. */
export function noteEndedLmStudioLoad(model: string, contextLength: number | null, now: number = Date.now()): void {
  ended.set(model, { model, contextLength, endedAt: now, quietLooks: 0, unloadedWhileLoading: false, unloading: null })
  unconfirmed = unconfirmed.filter((m) => m !== model)
  publish()
}

/** The model is wanted again: take it off the list and hand back what was written down. */
export function claimEndedLmStudioLoad(model: string): EndedLmStudioLoad | undefined {
  const entry = ended.get(model)
  if (!entry) return undefined
  ended.delete(model)
  publish()
  return entry
}

/** Still on the list as this very entry, not claimed and not ended again since. */
export function isEndedLmStudioLoad(entry: EndedLmStudioLoad): boolean {
  return ended.get(entry.model) === entry
}

/** The watch is done with `entry`: the model is gone, or it could not be confirmed. */
export function settleEndedLmStudioLoad(entry: EndedLmStudioLoad, outcome: 'gone' | 'unconfirmed'): void {
  if (!isEndedLmStudioLoad(entry)) return
  ended.delete(entry.model)
  if (outcome === 'unconfirmed') unconfirmed = [...unconfirmed, entry.model]
  else wentAt.set(entry.model, ++goneMark)
  publish()
}

/** The mark to take before asking LM Studio what is loaded. */
export function lmStudioGoneMark(): number {
  return goneMark
}

/**
 * Was `model` seen to be gone after `mark` was taken?
 *
 * A loaded list that was asked for before that moment may still name the
 * model: it sat in memory for about a second before the unload took it. Such
 * a list is older than what is known, and whoever shows it leaves the model
 * out. Without this the row read "On" for a second after "Cancelling" (hand
 * test, 11.10.2026).
 */
export function lmStudioWentAfter(model: string, mark: number): boolean {
  return (wentAt.get(model) ?? 0) > mark
}

export function endedLmStudioLoads(): EndedLmStudioLoad[] {
  return [...ended.values()]
}

/** The sentence about the unconfirmed models was read. */
export function dismissUnconfirmedLmStudioLoads(): void {
  if (unconfirmed.length === 0) return
  unconfirmed = []
  publish()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useEndedLmStudioLoads(): EndedLmStudioLoads {
  return useSyncExternalStore(subscribe, () => view)
}

/** What the picker says when the watch gave up on a model. */
export function lmStudioUnconfirmedSentence(labels: string[]): string {
  return `LM Studio did not confirm that it dropped ${labels.join(', ')}. If it shows as loaded there, unload it in LM Studio.`
}

/** Test-only: what the hook hands a component, read without one. */
export function endedLmStudioLoadsViewForTests(): EndedLmStudioLoads {
  return view
}

/** Test-only: module state lasts a session by design. */
export function __resetEndedLmStudioLoadsForTests(): void {
  ended.clear()
  wentAt.clear()
  goneMark = 0
  unconfirmed = []
  publish()
}
