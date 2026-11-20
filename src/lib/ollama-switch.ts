/**
 * The load switch of an Ollama row in the model picker: what it is while a
 * load or unload runs, and the sentences the picker says about it.
 *
 * Hand test of 3.0.6 on 10.10.2026: the switch of a second model turned for as
 * long as anyone watched. Ollama could not make room, because the model that
 * was loaded was still answering, and the picker had no word for it, no way to
 * stop, and every other Ollama switch was off for as long as it lasted.
 *
 * The rule every load switch follows is in lib/load-switch.ts (one switch at
 * a time, the switch of the loading model is its Cancel, an unload has nothing
 * to cancel). What is Ollama's own:
 *
 *   - Picking a row is never held back by an Ollama switch. A pick of an
 *     Ollama model loads nothing, it only names the model the next message
 *     goes to. Rows are switched off for a pick that is itself a load (LM
 *     Studio, the LU Engine); that rule is `pickInFlight` in the picker and an
 *     Ollama switch is deliberately not part of it.
 *   - "Unload all models" stays available during a load and ends it first.
 *
 * Pure, so the rule can be tested without mounting the picker.
 */
import { loadSwitchState, loadSwitchFailedSentence, type LoadSwitchRun, type LoadSwitchState } from './load-switch'

/** The switch that is running right now. */
export type OllamaSwitchRun = LoadSwitchRun
export type OllamaSwitchState = LoadSwitchState
export const ollamaSwitchState = loadSwitchState

/** Why a pending load is not moving, or null when it waits for nobody. */
export function waitingForSentence(ahead: readonly string[]): string | null {
  if (ahead.length === 0) return null
  if (ahead.length === 1) return `Waiting for ${ahead[0]} to finish.`
  return `Waiting for ${ahead[0]} and ${ahead.length - 1} more to finish.`
}

/** After an unload that Ollama accepted but has not carried out yet. */
export function stillBusySentence(busy: readonly string[]): string {
  if (busy.length === 1) return `${busy[0]} is still busy. It unloads when the running answer ends.`
  return `${busy.length} models are still busy. They unload when the running answers end.`
}

/** What the picker says when an Ollama switch did not do what was asked. */
export function switchFailedSentence(
  kind: OllamaSwitchRun['kind'],
  label: string,
  failure: { timedOut: boolean; reason?: string },
): string {
  return loadSwitchFailedSentence('Ollama', kind, label, failure)
}
