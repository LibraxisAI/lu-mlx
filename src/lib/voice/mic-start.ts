// The first seconds of a voice session's microphone.
//
// Two things happen before the first answer that the rest of a session does
// not have: the voice loop is not connected yet, and the echo cancellation of
// the webview has never heard this app play anything. Both made a user who
// spoke early go unheard. This file holds the three small pieces that deal
// with it. No audio API in here, the media manager wires them up.

/**
 * A tone on the output that nobody hears, played once when a microphone is
 * opened.
 *
 * Measured in the Windows build on 07.10.2026 (WebView2 154, probes in
 * proof/a13): Chromium's echo cancellation turns the microphone down by 13 to
 * 17 dB on average, in places to nothing, for the first seven seconds in which
 * the app plays sound, when no echo of that sound comes back (a headset, or a
 * quiet speaker). That is the first answer of a session, so a user who spoke
 * into it was not heard. It is neither the gain control nor the noise
 * suppression: with only echo cancellation off the loss is 0 dB. The seven
 * seconds count played sound, not time, and any sound above about -47 dBFS
 * counts, so a tone before the first answer uses them up, also when 25 s of
 * silence lie in between. How much tone it takes depends on the microphone.
 * While the user talks, 2.5 s of a 20 Hz tone at -42 dBFS are enough. With a
 * microphone that delivers pure silence meanwhile it takes more. Ten sessions
 * each in the Windows build, a sentence spoken two seconds into the first
 * answer: 3.5 s at -42 dBFS, 1 of 10 arrived whole. 6 s at -42 dBFS, 8 of 10.
 * 6 s at -36 dBFS, 10 of 10. A tone at 19 kHz does nothing.
 *
 * 20 Hz at -36 dBFS is below what an ear picks up at any volume a voice is
 * comfortable at, and most speakers do not reproduce it at all.
 *
 * The price: while the tone plays, a voice that reaches the microphone weakly
 * (a far microphone in a room, measured at -31 dBFS) is turned down by about
 * 15 dB. A voice at a normal level is not (0 dB). The tone starts with the
 * click, when hardly anybody is talking yet.
 */
export const SETTLE_TONE_HZ = 20
export const SETTLE_TONE_GAIN = 10 ** (-36 / 20)
export const SETTLE_TONE_SECS = 6
/** The tone fades in and out over this long, so it never clicks. */
export const SETTLE_TONE_FADE_SECS = 0.1

/**
 * How long the microphone is kept silent from the first sound of the first
 * answer after the tone.
 *
 * The tone has a price with a loud speaker next to the microphone: the echo
 * cancellation has concluded that nothing comes back, and lets the first 0.1 s
 * of real echo through before it catches on (measured 0.19 to 0.30 s after
 * the answer began, in 5 of 14 runs, peak -15 dBFS, never at a later answer).
 * The assistant would hear itself for that instant. Nobody interrupts an
 * answer in its first half second, so the microphone sends silence then.
 */
export const FIRST_SPEECH_GUARD_SECS = 0.6
/** The guard grows with the delay of the output device, up to this. */
export const FIRST_SPEECH_GUARD_MAX_SECS = 1.5

/** Silence for the microphone around the first answer after a settle tone. */
export class FirstSpeechGuard {
  private armed = false
  private from = 0
  private until = 0

  /** A settle tone was started: the next answer that begins is guarded. */
  arm(): void {
    this.armed = true
  }

  /** An answer starts playing at `at` on a device that delays it by `latencySecs`. */
  speechStarts(at: number, latencySecs: number): void {
    if (!this.armed) return
    this.armed = false
    const delay = Number.isFinite(latencySecs) && latencySecs > 0 ? latencySecs : 0
    this.from = at
    this.until = at + Math.min(FIRST_SPEECH_GUARD_SECS + delay, FIRST_SPEECH_GUARD_MAX_SECS)
  }

  /** Whether what the microphone delivers at `now` is replaced by silence. */
  silences(now: number): boolean {
    return now >= this.from && now < this.until
  }

  reset(): void {
    this.armed = false
    this.from = 0
    this.until = 0
  }
}

/**
 * How much of the microphone is kept while the voice loop is not connected.
 * A cold start loads the speech models and often the chat model too, and
 * what the user says meanwhile is answered once the session is up. On the
 * Windows test machine the connection came 24 to 34 s after the click, and
 * with thirty seconds kept a question asked in the second second was gone
 * again. A minute at 16 kHz is just under two megabytes.
 */
export const HELD_MIC_SECS = 60

/**
 * How fast held audio is sent once the session is up, against real time.
 *
 * Not all at once: the voice loop decides what is speech a step after its
 * recognizer has taken the audio in, and the recognizer keeps three seconds
 * for a sentence that has not been detected yet. Ten seconds in one burst are
 * past the recognizer before the first word is detected, and it transcribes
 * the silence at the end (seen 07.10.2026: speech detected, no transcript).
 * At eight times real time the two stay a few hundredths of a second apart,
 * and a full minute is through in under eight.
 */
export const HELD_MIC_SPEED = 8

/** How many held chunks are due after `elapsedSecs` of sending, at least one. */
export function heldChunksDue(elapsedSecs: number, rate: number, chunkSamples: number): number {
  const due = Math.floor((Math.max(0, elapsedSecs) * HELD_MIC_SPEED * rate) / chunkSamples)
  return Math.max(1, due)
}

/** The newest microphone chunks, up to a fixed number. Older ones fall out. */
export class HeldAudio {
  private chunks: Int16Array[] = []
  private readonly maxChunks: number

  constructor(maxChunks: number) {
    this.maxChunks = Math.max(1, Math.floor(maxChunks))
  }

  static forSeconds(seconds: number, rate: number, chunkSamples: number): HeldAudio {
    return new HeldAudio(Math.ceil((seconds * rate) / chunkSamples))
  }

  get length(): number {
    return this.chunks.length
  }

  push(chunk: Int16Array): void {
    this.chunks.push(chunk)
    if (this.chunks.length > this.maxChunks) this.chunks.splice(0, this.chunks.length - this.maxChunks)
  }

  /** The oldest `count` chunks, in order. They are no longer held afterwards. */
  take(count: number): Int16Array[] {
    return this.chunks.splice(0, Math.max(0, Math.floor(count)))
  }

  clear(): void {
    this.chunks = []
  }
}
