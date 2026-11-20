// What a run that looked at the screen may leave behind as a memory.
//
// Memories are written from a conversation after it happened. A run that
// used computer control has screen content in its answers: the assistant
// says what an email said, what a page showed, which name stood in a field.
// None of that was told to LU by the user, and some of it is other people's
// data. So such a run is remembered by the user's own words only. The
// assistant's side is replaced by one neutral line, and the memory is marked
// with the source "screen" so the user can see where it came from.

import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from './prompt'

export const SCREEN_TOOLS: ReadonlySet<string> = new Set([COMPUTER_USE_TOOL_NAME, COMPUTER_TASK_TOOL_NAME, 'screenshot'])

/**
 * Stands in for the assistant's answers of a run that saw the screen.
 *
 * A statement, never an instruction. The first wording ended with "Only
 * remember what the user said about themselves", and the extraction model
 * saved exactly that sentence as a memory of the user ("Memory scope
 * guidelines", seen on the box on 07.10.2026).
 */
export const SCREEN_RUN_STAND_IN =
  'The assistant worked on the screen for the user. What it saw there is not part of this record.'

export interface MemoryPair {
  user: string
  assistant: string
  sourceKind: 'chat' | 'voice' | 'screen'
}

/** The pair handed to the memory extraction for one run. */
export function memoryPairForRun(input: { user: string; assistant: string; toolNames: readonly string[]; sourceKind: 'chat' | 'voice' }): MemoryPair {
  if (!input.toolNames.some((name) => SCREEN_TOOLS.has(name))) {
    return { user: input.user, assistant: input.assistant, sourceKind: input.sourceKind }
  }
  return { user: input.user, assistant: SCREEN_RUN_STAND_IN, sourceKind: 'screen' }
}
