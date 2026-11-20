/**
 * The currently running `/loop`s, so none of them is ever invisible.
 *
 * A loop has no built-in pass ceiling by design: if someone asks it to keep
 * going, it keeps going until it says done or they stop it. That is only
 * defensible if the user can always SEE that a loop is live, which pass it is
 * on, and stop it in one click. Hence this store and the bar it feeds.
 *
 * ── B2: PER CONVERSATION, NOT ONE GLOBAL SLOT ─────────────────────────────
 *
 * This used to hold a single `loop: ActiveLoop | null`. `stopAgent` /
 * `stopCodex` called `clear()` unconditionally, on EVERY Stop press,
 * regardless of which conversation the press was for, because there was
 * only ever one slot to clear. A `/loop` in conversation A died the moment
 * the user pressed Stop in conversation B: not a rare race, a guaranteed
 * outcome of two conversations ever running a loop "at the same time" (one
 * of them waiting out its interval counts). See
 * agentLoopStore.two-loops-do-not-share-a-slot.test.ts.
 *
 * Runtime only — a loop does not survive a restart, and pretending otherwise
 * by persisting it would leave a dead loop on screen after a crash.
 */

import { create } from 'zustand'

export interface ActiveLoop {
  conversationId: string
  /** The pass that is about to start. */
  pass: number
  /** 0 = unlimited (settings.loopMaxPasses). */
  cap: number
  task: string
  intervalMs: number
  /** When the next pass fires, for the countdown. */
  nextAt: number
}

interface AgentLoopState {
  /** conversationId → its own active loop. Absent = no loop standing there. */
  loops: Record<string, ActiveLoop>
  start: (loop: ActiveLoop) => void
  /** Clears ONLY this conversation's loop. A bare `clear()` with no id would
   *  reintroduce the single-slot bug this store exists to end, there is no
   *  overload for it. */
  clear: (conversationId: string) => void
}

export const useAgentLoopStore = create<AgentLoopState>((set) => ({
  loops: {},
  start: (loop) =>
    set((state) => ({ loops: { ...state.loops, [loop.conversationId]: loop } })),
  clear: (conversationId) =>
    set((state) => {
      if (!conversationId || !state.loops[conversationId]) return state
      const next = { ...state.loops }
      delete next[conversationId]
      return { loops: next }
    }),
}))

/** The loop of ONE conversation, or `undefined`. For LoopBar, which shows
 *  only the ACTIVE conversation's own loop, a loop running elsewhere must
 *  not paint this bar or steal its Stop button. */
export function useConversationLoop(conversationId: string | null | undefined): ActiveLoop | undefined {
  return useAgentLoopStore((s) => (conversationId ? s.loops[conversationId] : undefined))
}

/**
 * Is ANY conversation's loop running right now, anywhere?
 *
 * For the Coding Agent's working-directory lock (codexBusyReason): the
 * folder is a single GLOBAL value shared by every Codex conversation (A8,
 * 2.6.8: "moving it mid-run would send the next turn somewhere the user is
 * not looking"), so a loop in a DIFFERENT conversation still writes through
 * that same folder and still must not have it yanked out from under it. This
 * is deliberately NOT scoped to the active conversation, unlike LoopBar.
 */
export function useAnyAgentLoopActive(): boolean {
  return useAgentLoopStore((s) => Object.keys(s.loops).length > 0)
}

/**
 * End the loop of a pass that settled without arming a next one (GH #140).
 *
 * A pass can end before it reaches the driver that re-arms or clears the loop:
 * the run guard, a lane that was cancelled, no model picked, a throw before
 * the tool loop. Such a pass left the bar saying "running" for a loop that was
 * over, and the Code view kept the working folder locked behind it
 * (useAnyAgentLoopActive). `rearmed` asks the caller's own timer map whether
 * the driver scheduled the next pass meanwhile. A rejected pass still rejects
 * the returned promise, so nothing that used to reach the console is hidden.
 */
export function endLoopUnlessRearmed(conversationId: string, pass: unknown, rearmed: () => boolean): Promise<unknown> {
  return Promise.resolve(pass).finally(() => {
    if (!rearmed()) useAgentLoopStore.getState().clear(conversationId)
  })
}
