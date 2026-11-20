// What a running voice session does with the LU Cloud key.
//
// The key is the sign-in token, and it expires within the hour. The voice
// loop holds the key it was started with, so a long session would end in a
// refused request. The session asks for the current token once a minute and
// decides here what follows.

export type CloudKeyStep =
  | { kind: 'keep' }
  /** A renewed token: hand it to the voice loop. */
  | { kind: 'renew'; key: string }
  /** No sign-in any more: end the session with a clear sentence. */
  | { kind: 'signed-out' }

export const SIGNED_OUT_MESSAGE = 'Your LU Cloud sign-in ended, so the session stopped. Sign in again and start a new session.'

export function cloudKeyStep(current: string | null, token: string | null): CloudKeyStep {
  if (!token) return { kind: 'signed-out' }
  return token === current ? { kind: 'keep' } : { kind: 'renew', key: token }
}
