// The questions of computer control, as a voice session asks them aloud.
//
// A question is also on the screen, with everything in it. What is spoken is
// short, because the user hears it at speaking pace and may have to hear one
// per action.
//
// WHERE A SPOKEN YES COUNTS, AND WHERE IT DOES NOT
//
// A spoken yes is weaker than a click. Speech recognition mishears, and the
// microphone hears the room: a video, a call, a web page that plays a voice.
// The echo cancellation removes what LU itself says, not what another app
// plays. So the voice may answer only where a wrong yes is cheap:
//
//   - May LU use this app? Yes means "for this session", never "always".
//     The blocklist and every later check still apply, and "stop" holds it.
//   - Run this one ordinary action in a supervised session? A click, a
//     scroll, text in a field.
//
// Anything computer control itself marks as sensitive (sending, buying,
// deleting, changing permissions, a target it cannot identify, typing when
// the focus is unknown) keeps the click. Such a question is announced, and a
// spoken yes is not accepted for it. A spoken no is always accepted:
// declining is safe.

import type { ComputerPrompt } from '../../stores/computerStore'
import type { AppAnswer } from './prompts'

export interface SpokenQuestion {
  text: string
  /** A spoken yes answers it. False: it needs the click. */
  voice: boolean
}

const VERB: [RegExp, string][] = [
  [/^Double click\b/, 'double click'],
  [/^Right click\b/, 'right click'],
  [/^Click\b/, 'click'],
  [/^Move the pointer\b/, 'move the pointer'],
  [/^Drag\b/, 'drag something'],
  [/^Scroll\b/, 'scroll'],
  [/^Type\b/, 'type some text'],
  [/^Press\b/, 'press a key'],
  [/^Wait\b/, 'wait'],
  [/^Bring\b/, 'bring a window to the front'],
]

/** Speech has no use for "at 662, 511", and typed text is not read out. */
function spokenVerb(description: string): string {
  return VERB.find(([pattern]) => pattern.test(description))?.[1] ?? 'do the next step'
}

function spokenName(name: string): string {
  return name.replace(/\.exe$/i, '').replace(/[^\p{L}\p{N} .+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}

export function spokenQuestion(prompt: ComputerPrompt): SpokenQuestion {
  if (prompt.kind === 'permission') {
    // Only the user can grant it, in the settings of the system. No voice answers this.
    const name = prompt.permission === 'accessibility' ? 'Accessibility' : 'Screen Recording'
    return { text: `Your Mac has to allow this first. Please look at the screen: I need the ${name} permission.`, voice: false }
  }
  const app = prompt.app ? spokenName(prompt.app.name || prompt.app.key) : ''
  if (prompt.kind === 'app') {
    return { text: `May I work in ${app || 'this app'}? Say yes or no.`, voice: true }
  }
  const where = app ? ` in ${app}` : ''
  if (prompt.sensitive) {
    return { text: `I want to ${spokenVerb(prompt.description)}${where}. This one needs your click on the screen.`, voice: false }
  }
  return { text: `I want to ${spokenVerb(prompt.description)}${where}. Yes or no?`, voice: true }
}

/** What a spoken answer means for the question on screen, or null: not accepted. */
export function spokenAnswer(prompt: ComputerPrompt, answer: 'yes' | 'no'): AppAnswer | boolean | null {
  if (answer === 'no') return prompt.kind === 'app' ? 'deny' : false
  if (prompt.kind === 'permission' || !spokenQuestion(prompt).voice) return null
  return prompt.kind === 'app' ? 'session' : true
}
