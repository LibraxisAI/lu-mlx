// Spoken yes, no, stop and wait, as the voice loop matches them.
//
// The voice loop decides (resources/voice_loop/lu_voice_loop/commands.py): it
// takes such an utterance out before the model hears it and tells the app.
// The app still receives the transcript of every utterance, so it needs the
// same answer to one question only: was this a command, or did the user ask
// for something? Both matchers are tested against one list of utterances
// (voice_loop/tests/fixtures/voice_commands.json), so they cannot drift.

export type SpokenCommand = 'yes' | 'no' | 'stop'

const YES = new Set([
  'yes', 'yes please', 'yeah', 'yep', 'ok', 'okay', 'sure', 'go ahead', 'do it',
  'yes do it', 'yes go ahead', 'confirm', 'allow', 'allow it',
])
const NO = new Set(['no', 'no thanks', 'no thank you', 'nope', 'dont', 'do not', 'deny', 'decline', 'no dont'])
const STOP = new Set([
  'stop', 'stop it', 'stop that', 'stop now', 'please stop', 'stop please',
  'stop everything', 'stop the task', 'cancel', 'cancel that', 'cancel it', 'abort',
  // Meant the same while a task runs: hold it. The app pauses for all of them.
  'wait', 'wait a moment', 'wait a second', 'hold on', 'pause', 'pause it',
])

export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/-/g, ' ').replace(/[^a-z ]+/g, '').split(' ').filter(Boolean).join(' ')
}

/** "yes", "no", "stop" or null, for one whole utterance. */
export function spokenCommand(text: string): SpokenCommand | null {
  const words = normalizeUtterance(text)
  if (STOP.has(words)) return 'stop'
  if (YES.has(words)) return 'yes'
  if (NO.has(words)) return 'no'
  return null
}
