/**
 * The load switch of a local model row in the model picker: what it is while
 * a load or unload runs, and the sentences the picker says about it.
 *
 * One rule for every backend whose rows carry a switch. What differs between
 * the backends (whether a pick is itself a load, what a pending load waits
 * for) is written down next to each: lib/ollama-switch.ts and
 * lib/lmstudio-switch.ts.
 *
 *   - One switch of a backend runs at a time. While it runs the other
 *     switches of that backend are off, so two loads never fight for the same
 *     memory.
 *   - The switch of the model that is LOADING is its Cancel. A load therefore
 *     never locks the others for longer than the person wants.
 *   - An unload is over in seconds and has nothing to cancel.
 *
 * Pure, so the rule can be tested without mounting the picker.
 */

/** The switch that is running right now. */
export interface LoadSwitchRun {
  name: string
  kind: 'load' | 'unload'
}

/**
 * - `idle`: nothing runs, the switch loads or unloads.
 * - `cancel`: this row is loading; a click ends the load.
 * - `busy`: this row is unloading; nothing to click.
 * - `off`: another row's switch runs.
 * - `cancelling`: this row's load was ended and the backend has not let go of
 *   the model yet; nothing to click until it has.
 */
export type LoadSwitchState = 'idle' | 'cancel' | 'busy' | 'off' | 'cancelling'

export function loadSwitchState(rowName: string, run: LoadSwitchRun | null): LoadSwitchState {
  if (!run) return 'idle'
  if (run.name !== rowName) return 'off'
  return run.kind === 'load' ? 'cancel' : 'busy'
}

/**
 * What the picker says when a switch did not do what was asked. `backend` is
 * the name the app shows for the backend. `reason` is the backend's own
 * sentence when it gave one, and is left out otherwise.
 */
export function loadSwitchFailedSentence(
  backend: string,
  kind: LoadSwitchRun['kind'],
  label: string,
  failure: { timedOut: boolean; reason?: string },
): string {
  if (failure.timedOut) {
    return kind === 'load'
      ? `Loading ${label} took too long and was stopped. Try again.`
      : `${backend} did not answer the unload of ${label}. Try again.`
  }
  const what = kind === 'load' ? `Could not load ${label}.` : `Could not unload ${label}.`
  return failure.reason ? `${what} ${failure.reason}` : what
}
