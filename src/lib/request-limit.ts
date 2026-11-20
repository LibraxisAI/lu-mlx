// What the user reads when a server answers HTTP 429 for a request limit.
//
// One rule for chat, agent, code and voice: a sentence the server sent is
// shown word for word. The server knows which limit it was (one model's limit
// that all customers share, one account's burst guard, a second request while
// the first is running) and how long it lasts. The app does not, so its own
// sentence is only the fallback for an answer that carries no words, and it
// claims nothing about whose limit it is.
//
// An empty wallet also answers 429. It carries `credits_exhausted` and has its
// own message (lib/credits-exhausted.ts); every caller judges it first.

/** The status line and nothing else: no sentence a user could act on. */
const BARE_LABEL = /^(?:error:?\s*)?(?:http\s*)?(?:429\s*[:-]?\s*)?(?:too many requests|rate limit(?:ed)?(?: exceeded| reached)?|request failed(?:\s*\(429\))?)?[.!]?$/i

/** The server's own sentence, or null when it sent none or only the label. */
export function serverLimitSentence(text: unknown): string | null {
  const said = typeof text === 'string' ? text.trim() : ''
  return said && !BARE_LABEL.test(said) ? said : null
}

export interface RequestLimitFacts {
  /** What the server wrote, if anything. */
  said?: unknown
  /** The wait from `retry-after`, in milliseconds. */
  retryAfterMs?: unknown
  /** True for LU Cloud, which books nothing for a refused request. Never set
   *  for a server whose billing the app does not know. */
  nothingCharged?: boolean
  /** What the user does next, for example "say it again" in a voice session. */
  again?: string
}

function waitWords(retryAfterMs: unknown): string | null {
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null
  const seconds = Math.ceil(retryAfterMs / 1000)
  if (seconds <= 90) return `about ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  return `about ${Math.ceil(seconds / 60)} minutes`
}

/** The sentence to show: the server's when it sent one, ours otherwise. */
export function requestLimitMessage(facts: RequestLimitFacts): string {
  const sentence = serverLimitSentence(facts.said)
  if (sentence) return sentence
  const again = facts.again ?? 'send your message again'
  const wait = waitWords(facts.retryAfterMs)
  const what = wait
    ? `The server is limiting requests right now. Please ${again} in ${wait}.`
    : `The server is limiting requests right now. Please wait a moment, then ${again}.`
  return facts.nothingCharged ? `${what} Nothing was charged.` : what
}

/** The same for a caught error: its text and its `retryAfterMs` field. */
export function requestLimitMessageOf(err: unknown, facts?: Omit<RequestLimitFacts, 'said' | 'retryAfterMs'>): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { message?: unknown; retryAfterMs?: unknown }
  return requestLimitMessage({ ...facts, said: typeof err === 'string' ? err : e.message, retryAfterMs: e.retryAfterMs })
}
