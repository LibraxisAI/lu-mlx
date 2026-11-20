// An error the voice loop reports during a session, and what the app does
// with it.
//
// The voice loop marks an error as fatal when its pipeline has stopped. Every
// other error is one piece of work that failed: one sentence that could not
// be spoken, one utterance that could not be recognized, one request the
// model server refused. The session is still there after it, so the app does
// not end it. It writes the error to the log and, where the user is missing
// something because of it, says so in one line under the status.

import { requestLimitMessage } from '../request-limit'

/** The longest piece of the voice loop's own words a hint carries. */
const MAX_HINT_DETAIL = 140

export interface LoopError {
  /** The pipeline has stopped: the session is over. */
  fatal: boolean
  /** The voice loop's own sentence, for the log and for the end of a session. */
  detail: string
  /** One line for the user while the session goes on. Null: nothing they would miss. */
  hint: string | null
}

export const SPEECH_FAILED_HINT = 'One answer could not be spoken. The session goes on.'
export const HEARING_FAILED_HINT = 'LU could not make out what you said. Please say it again.'

/**
 * Read the data of an RTVI error message. `clean` takes secrets out of the
 * text and shortens it. An error without the fatal mark of the protocol is
 * treated as fatal: the app cannot tell that the session survived it.
 */
export function readLoopError(data: unknown, clean: (text: unknown) => string): LoopError {
  const fields = (typeof data === 'object' && data !== null ? data : {}) as { error?: unknown; message?: unknown; fatal?: unknown }
  const detail = clean(fields.error ?? fields.message)
  if (fields.fatal !== false) return { fatal: true, detail, hint: null }
  return { fatal: false, detail, hint: hintFor(detail) }
}

function hintFor(detail: string): string | null {
  if (!detail) return null
  // HTTP 429 from the model server. The voice loop sends the server's own
  // sentence behind this prefix (pipeline.py, REQUEST_LIMIT_PREFIX), and it is
  // shown word for word, as in chat. Whose server it is and what it charges is
  // not known here, so the fallback says neither.
  const limit = /^Request limit:\s*(.*)$/s.exec(detail)
  if (limit) return requestLimitMessage({ said: limit[1], again: 'ask again' })
  if (/^Speech synthesis failed/i.test(detail)) return SPEECH_FAILED_HINT
  if (/^Speech recognition failed/i.test(detail)) return HEARING_FAILED_HINT
  const said = detail.length > MAX_HINT_DETAIL ? `${detail.slice(0, MAX_HINT_DETAIL)}...` : `${detail.replace(/[.\s]+$/, '')}.`
  return `Something went wrong: ${said} The session goes on.`
}
