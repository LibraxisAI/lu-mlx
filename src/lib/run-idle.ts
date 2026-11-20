/**
 * "Is something running right now?" — asked and answered in ONE place.
 *
 * G25 (R17c witness 2026-08-07): backend detection resolves asynchronously a
 * few seconds after startup, so the "Multiple backends running" selector could
 * open MID RUN and stand over the chat for the rest of a 20 minute agent run.
 * Detection is a startup convenience; an active run is the one thing on screen
 * the user is actually watching. Any modal it wants to open waits here until
 * every surface is idle.
 *
 * ── AS-08 ────────────────────────────────────────────────────────────────
 * The app keeps the fact "a run is in flight" in two stores, and they are not
 * redundant copies of one another:
 *
 *  1. `generationStore.generating[convId]` — Chat, Agent AND the Coding Agent
 *     all set it (`useChat.ts:639`, `useAgentChat.ts:599`, `useCodex.ts:756`).
 *     It is the flag the Stop button and the typing indicator hang off.
 *  2. `codexStore.threads[convId].status` — only the Coding Agent has one, and
 *     it is the only signal that can carry WHAT the run is doing rather than
 *     just THAT it is running.
 *
 * Neither one alone is the truth, and they disagree in windows that are easy
 * to hit. `stopCodex` (`useCodex.ts:2605`) calls `abortConversation` at `:2614`,
 * which deletes `generating[convId]` synchronously, while the thread's status only
 * returns to 'idle' when the aborted run finishes unwinding in its `finally`
 * (`useCodex.ts:2517`) — a shell command that does not honour the signal
 * promptly stretches that window to seconds. During it, source 1 says idle and
 * source 2 says running. That window has a name now: `cancelling`.
 *
 * So the fix is not to pick a winner, it is to stop asking the question in
 * more than one place. This module reconciles both sources once and hands out
 * the verdict; `types/codex.ts` owns the classification of the states
 * themselves, as a total map, so a new state cannot slip through as a silent
 * `else`.
 *
 * ── A THIRD SOURCE, AND WHY IT BELONGS HERE ──────────────────────────────
 * `lib/run-lanes.ts` holds runs that have been asked for and are waiting for
 * the single local GPU. Such a run is in NEITHER store: no `generating` flag,
 * no thread, because the run has not started and nothing has set anything.
 * Left out,
 * it reads as `idle`, and the composer shows Send for a conversation whose run
 * is already booked. Pressing Send there books a second one, and both then
 * queue behind each other.
 *
 * It is asked the same way `run-stop.ts` is: module state keyed by
 * conversation, read live, never mirrored into a store. Mirroring it would
 * recreate the exact defect this file exists to fix, a fact kept in two
 * places that disagree in the window between them.
 *
 * STILL OPEN (locked files, reported rather than papered over):
 *   - `components/chat/CodexModeDropdown.tsx:53` and
 *     `components/chat/PlanApprovalBar.tsx:45` each compute their own
 *     `generating[convId] === true` and never look at the thread. Both should
 *     call `isRunActive(convId)`.
 *   - `stores/chatStore.ts:59` (`dropConversationSideState`) sweeps four
 *     stores when a chat is deleted and does not include `codexStore.threads`,
 *     so a deleted coding chat leaves its thread behind — and its status keeps
 *     voting in `anyRunActive` below.
 */
import { useSyncExternalStore } from 'react'
import { useGenerationStore } from '../stores/generationStore'
import { useCodexStore } from '../stores/codexStore'
import { isRunStopped } from './run-stop'
import { anyRunQueued, isRunQueued, localLaneHolder, runQueuePosition, subscribeRunLanes } from './run-lanes'
import { headApproval, subscribeApprovals } from './approval-queue'
import { isActiveCodexStatus, type CodexThreadStatus } from '../types/codex'

/**
 * Pure verdict over the two run signals, for the whole app: any generating
 * conversation, or any coding thread in a state that means work is in flight.
 *
 * The second half used to read `t.status === 'running'`, which answered "idle"
 * for a thread that was awaiting approval, applying its staged changes or
 * cancelling. The classification now lives with the union in `types/codex.ts`.
 * Exported for the unit tests and for callers that already hold both maps.
 */
export function anyRunActive(
  generating: Record<string, boolean>,
  threads: Record<string, { status: CodexThreadStatus }>,
): boolean {
  if (Object.values(generating).some(Boolean)) return true
  return Object.values(threads).some((t) => isActiveCodexStatus(t.status))
}

/**
 * Is ANY surface of the app busy right now? Reads both stores live, plus the
 * local lane's waiting room.
 *
 * The queue is a THIRD source and deliberately not a parameter of
 * `anyRunActive` above: that one is the pure verdict over the two store maps
 * and its callers hold those maps already. A queued run is in neither map,
 * having no `generating` flag and no thread, so it has to be asked for
 * separately, the same way `runStatusOf` asks `run-stop.ts`.
 *
 * It has to be asked at all because of `whenRunsIdle` below: a run that is
 * about to start is exactly the G25 case in the header. Opening a modal in the
 * half-second before the queue promotes it puts the modal over a run instead
 * of before it.
 *
 * That gap used to be wider than a read: `whenRunsIdle` woke on the two store
 * subscriptions only, and dropping a waiting run out of the queue (Stop
 * pressed before its turn) changes NEITHER store, so a deferred `show` sat
 * there until some unrelated store change happened to come along. The queue
 * now says so itself (`subscribeRunLanes`), and `whenRunsIdle` listens to all
 * three. That is not a fourth copy of the fact: it is the same module state,
 * read the same way, with a wake-up attached.
 */
export function runsActive(): boolean {
  if (anyRunQueued()) return true
  return anyRunActive(
    useGenerationStore.getState().generating,
    useCodexStore.getState().threads,
  )
}

/**
 * What is this one conversation's run doing right now — the single verdict,
 * reconciled from both sources.
 *
 * Order matters and each step is a fact, not a guess:
 *   - Not active by either store, but waiting for the local lane → `queued`.
 *     This is asked FIRST of the inactive cases, and before `error`: a
 *     conversation whose last run failed and whose next run is already booked
 *     reads `queued`, not `error`. The older verdict would be about a run that
 *     is over while a newer one is pending.
 *   - Not active by either source → `error` if the thread recorded one,
 *     otherwise `idle`.
 *   - Active and the user pressed Stop → `cancelling`. `run-stop.ts` is keyed
 *     by conversation and is the one thing that knows this; the flag is sticky
 *     after the run ends, which is why it is only read once the run is already
 *     known to be active.
 *   - Active with a thread that names its own state → that state
 *     (`awaiting_approval` / `applying`), for whoever sets it.
 *   - Active otherwise → `running`.
 *
 * A queued run is NOT checked against the sticky stop flag, and that is safe
 * by construction rather than by luck: `beginRun` clears the flag at the top
 * of a user-initiated run, and admission to a lane happens inside such a run.
 * A conversation cannot be freshly queued and still carry a stop from before.
 * Stopping a run that is still WAITING is a queue operation, not a status
 * one: `release` drops it out. The row must leave the waiting room, otherwise
 * the composer keeps showing a cancelled run as pending.
 */
export function runStatusOf(conversationId: string | null | undefined): CodexThreadStatus {
  if (!conversationId) return 'idle'
  return runStatusFrom(
    useGenerationStore.getState().generating[conversationId] === true,
    useCodexStore.getState().threads[conversationId]?.status,
    isRunStopped(conversationId),
    isRunQueued(conversationId),
  )
}

/**
 * Derselbe Spruch, aber aus mitgegebenen Werten statt aus dem Speicher.
 *
 * Eine React-Komponente darf den Speicher nicht per `getState()` lesen, sonst
 * zeichnet sie nicht neu, wenn er sich aendert. Sie abonniert die beiden
 * Quellen einzeln und fragt HIER nach dem Urteil, statt sich ein zweites
 * daneben zu bauen. Genau das ist der Fehler, den AS-08 oben beschreibt.
 * `runStatusOf` ist seitdem nur noch die Fassung, die selbst nachschlaegt.
 */
export function runStatusFrom(
  generating: boolean,
  thread: CodexThreadStatus | undefined,
  stopped: boolean,
  queued: boolean,
): CodexThreadStatus {
  const active = generating || (thread !== undefined && isActiveCodexStatus(thread))
  // Auch die Warteschlange kommt als Wert herein und wird hier NICHT selbst
  // nachgeschlagen. run-lanes fuehrt sie in einer Modulkarte, nicht in einem
  // Speicher, und ein Blick von hier aus wuerde die Komponente beim Einreihen
  // nicht neu zeichnen lassen. Das ist derselbe Fehler, den AS-08 oben
  // beschreibt, nur eine Quelle weiter.
  if (!active) {
    if (queued) return 'queued'
    return thread === 'error' ? 'error' : 'idle'
  }
  if (stopped) return 'cancelling'
  if (thread && thread !== 'running' && isActiveCodexStatus(thread)) return thread
  return 'running'
}

/**
 * Is a run in flight on this conversation? The question every per-conversation
 * caller should ask — never `generating[convId]` on its own, which is the half
 * of the truth that the Coding Agent's own Stop clears first.
 */
export function isRunActive(conversationId: string | null | undefined): boolean {
  return isActiveCodexStatus(runStatusOf(conversationId))
}

/**
 * React hook: is THIS conversation waiting in the local lane's queue right
 * now (Runde 4, review-lanes.md Blocker 1+6)?
 *
 * ChatView and CodexView both need this for the same two things: showing the
 * Stop button (not Send) while a send is queued, and the "waiting for the
 * local model" line. `useSyncExternalStore` with `subscribeRunLanes` is the
 * plain React wrapper around the module state `lib/run-lanes.ts` already
 * keeps and already wakes on, no second copy of "is it queued": the two
 * view components just read the same one fact reactively instead of via
 * `getState()`-equivalent calls that would not trigger a re-render when a
 * run gets promoted out of the queue.
 */
export function useIsQueuedForLocalLane(conversationId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeRunLanes, () => isRunQueued(conversationId))
}

/**
 * React hook: which position does this conversation hold in the local
 * lane's queue, if any? `null` when it is not waiting (running, or nothing
 * booked at all). Same `subscribeRunLanes` wiring as
 * `useIsQueuedForLocalLane`, kept as a separate hook rather than folded into
 * it because most callers only need the boolean and would otherwise re-render
 * on every position change of a queue they do not display a number for.
 *
 * Feeds the composer's waiting line with a real number instead of a bare "it
 * is waiting": `lib/run-lanes.ts`'s `runQueuePosition` existed for exactly
 * this since before Runde 4, wired up only now that a queue can actually
 * form.
 */
export function useLocalLaneQueuePosition(conversationId: string | null | undefined): number | null {
  return useSyncExternalStore(subscribeRunLanes, () => runQueuePosition(conversationId))
}

/** Both sources the wait-reason question below reads: the lane's own holder
 *  and queue, PLUS the approval queue, whose head decides whether the
 *  holder is answering or waiting on a human. */
function subscribeRunLanesAndApprovals(listener: () => void): () => void {
  const abLane = subscribeRunLanes(listener)
  const abApproval = subscribeApprovals(listener)
  return () => { abLane(); abApproval() }
}

/**
 * React hook: while THIS conversation waits in the local lane's queue, is the
 * holder ahead of it stuck on a HUMAN, not a model (Runde 5, review-lanes.md
 * Runde 2 Antwort zu Punkt 1, "Der wartende Agent")?
 *
 * `runInLane` holds the lane for the holder's WHOLE run, tool-approval wait
 * included, which is correct (the run is not over, and inference resumes the
 * moment the human answers). But "Waiting for the local model to finish
 * another answer" is a lie in that window: no model is thinking, a person is,
 * and there is no bound on how long a person takes. The line has to say that,
 * so a customer does not read a silent multi-minute wait as a hang and file
 * the exact support ticket B1 already fixed once (2026-06-16 lineage).
 *
 * `false` while not queued, or while the holder IS generating: the ordinary
 * "another answer" wording stays correct there and this hook must not flap
 * it every time a chunk arrives.
 */
export function useLocalLaneHolderWaitsForApproval(conversationId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeRunLanesAndApprovals, () => {
    if (!isRunQueued(conversationId)) return false
    const holder = localLaneHolder()
    return !!holder && headApproval(holder) !== null
  })
}

/** The title of the conversation currently holding the local lane, only
 *  while THIS conversation is queued behind it, for the "waiting on
 *  <name>'s approval" line. `null` covers both "not queued" and "no title
 *  available" so the caller can fall back to the generic wording either way. */
export function useLocalLaneHolderId(conversationId: string | null | undefined): string | null {
  return useSyncExternalStore(subscribeRunLanes, () => {
    if (!isRunQueued(conversationId)) return null
    return localLaneHolder()
  })
}

/**
 * Wake `listener` whenever ANY of the three sources moves: a generating flag,
 * a coding thread's status, or the local lane's queue.
 *
 * This exists so the list of sources is written down ONCE. Every reader of
 * this module needs the same three, and a reader that subscribes to two of
 * them shows no error: it shows a Stop button that never turns back into
 * Send, or a queue chip that stays on position 2 while the queue moves on.
 * That is the house's most expensive pattern, two paths and one of them
 * maintained, in the place where it is hardest to see.
 *
 * Meant for `useSyncExternalStore`, together with any of the verdict
 * functions above as the snapshot:
 *
 *     useSyncExternalStore(subscribeRuns, () => runStatusOf(convId))
 *
 * All of them answer with a plain value (a string, a number, a boolean), so
 * `Object.is` settles it and no snapshot has to be cached to keep its
 * identity.
 */
export function subscribeRuns(listener: () => void): () => void {
  const unsubs = [
    useGenerationStore.subscribe(listener),
    useCodexStore.subscribe(listener),
    subscribeRunLanes(listener),
  ]
  return () => { for (const u of unsubs) u() }
}

/**
 * Call `show` now when no run is active, otherwise the moment the last run
 * ends. Returns a cancel function that withdraws a still-deferred `show`
 * without firing it; after `show` ran, cancelling is a no-op. Neither store
 * persists a running flag across a restart (generationStore is ephemeral by
 * design, codexStore persists only the working directory), so a crash can
 * never leave this waiting on a ghost run.
 *
 * All THREE sources are listened to, through the one `subscribeRuns` above.
 * The third is the one that used to be missing: a run that is only booked,
 * waiting for the local lane, ends by leaving a queue that neither store can
 * see. Without that subscription the last waiting run could go away and leave
 * a deferred modal sitting.
 */
export function whenRunsIdle(show: () => void): () => void {
  if (!runsActive()) {
    show()
    return () => {}
  }
  let done = false
  let abmelden: (() => void) | null = null
  const check = () => {
    if (done || runsActive()) return
    done = true
    abmelden?.()
    show()
  }
  abmelden = subscribeRuns(check)
  return () => {
    done = true
    abmelden?.()
  }
}
