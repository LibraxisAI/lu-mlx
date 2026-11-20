// What the user said, as it enters the transcript and the record of a voice
// session, without the words that were a spoken command.
//
// The voice loop takes a spoken "yes", "no", "stop" or "wait" out before its
// model hears it (see commands.ts). The app is still sent the transcript of
// every utterance, the command included, and right after a command a blank
// one. Shown as it arrives, the "Yes" that answered a question on the screen
// stood in the transcript as something the user said to the model, and was
// kept in the record of the conversation.
//
// So an utterance that reads like a command waits for the verdict of the
// voice loop. A blank transcript says it was taken: it is dropped. Anything
// else says it was conversation (a "yes" while nothing was asked): the next
// utterance, the model starting to answer, or a short time without a blank.

import { spokenCommand } from './commands'

/**
 * How long a blank transcript may take to follow a command. The voice loop
 * sends it at once, or after the moment it gives "wait" to turn out to be
 * the start of a sentence (HOLD_GRACE_SECS in commands.py).
 */
export const COMMAND_VERDICT_MS = 1500

export class HeardUtterances {
  private held: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  /** A final utterance that belongs in the transcript. */
  private readonly keep: (text: string) => void
  private readonly verdictMs: number

  constructor(keep: (text: string) => void, verdictMs: number = COMMAND_VERDICT_MS) {
    this.keep = keep
    this.verdictMs = verdictMs
  }

  /** One final transcript from the voice loop, blank ones included. */
  final(text: string): void {
    if (!text.trim()) {
      // The voice loop took what came just before it.
      this.drop()
      return
    }
    this.release()
    if (spokenCommand(text) === null) {
      this.keep(text)
      return
    }
    this.held = text
    this.timer = setTimeout(() => this.release(), this.verdictMs)
  }

  /** Whatever waits was conversation: the model answers it, or time is up. */
  release(): void {
    const text = this.take()
    if (text !== null) this.keep(text)
  }

  /** Whatever waits was a command, or the session is over. */
  drop(): void {
    this.take()
  }

  private take(): string | null {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const text = this.held
    this.held = null
    return text
  }
}
