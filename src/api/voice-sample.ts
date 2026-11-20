// Hear a voice before choosing it.
//
// The voice engine speaks one fixed sentence in an installed voice and hands
// it back as a WAV file (POST /sample of the voice loop). Nothing is recorded
// and no session is needed. The engine has to be running for it, so the first
// sample after a while waits for the speech models to load.

import { detailOf } from '../lib/error-text'
import { voiceSessionActive, withVoiceEngine } from './voice-session'

export const SAMPLE_DURING_SESSION = 'Stop the voice session to listen to a voice.'
export const SAMPLE_FAILED = 'The voice could not be played. Try again. If this keeps happening, run Repair below.'

export interface VoiceSample {
  /** Resolves when the sample has played to its end or was stopped. Rejects with a sentence. */
  done: Promise<void>
  stop: () => void
}

type ContextCtor = typeof AudioContext

function audioContextCtor(): ContextCtor | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: ContextCtor }).webkitAudioContext
}

/**
 * Play the sample of `voice`. Call it from the click: the audio output is
 * opened before the first await, which is the only moment WebKit allows it.
 */
export function playVoiceSample(voice: string, onPlaying?: () => void): VoiceSample {
  const Context = audioContextCtor()
  if (voiceSessionActive()) return { done: Promise.reject(new Error(SAMPLE_DURING_SESSION)), stop: () => {} }
  if (!Context) return { done: Promise.reject(new Error(SAMPLE_FAILED)), stop: () => {} }

  const context = new Context()
  void context.resume().catch(() => {})
  const abort = new AbortController()
  let source: AudioBufferSourceNode | null = null
  let finish: (() => void) | null = null

  const stop = () => {
    abort.abort()
    try { source?.stop() } catch { /* it had not started or had already ended */ }
    finish?.()
  }

  const done = (async () => {
    try {
      // A sentence from Rust (not installed, setup running) or from the engine is kept as it is.
      const wav = await withVoiceEngine(async (loop) => {
        // "Failed to fetch" says nothing to a user: the engine is gone or not listening.
        const response = await fetch(`${loop.baseUrl}/sample`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${loop.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice }),
          signal: abort.signal,
        }).catch(() => { throw new Error(SAMPLE_FAILED) })
        if (!response.ok) {
          const refused = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(refused?.error || SAMPLE_FAILED)
        }
        return response.arrayBuffer().catch(() => { throw new Error(SAMPLE_FAILED) })
      })
      if (abort.signal.aborted) return
      const buffer = await context.decodeAudioData(wav).catch(() => { throw new Error(SAMPLE_FAILED) })
      if (abort.signal.aborted) return
      await new Promise<void>((resolve) => {
        finish = resolve
        source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => resolve()
        source.start()
        onPlaying?.()
      })
    } catch (error) {
      if (abort.signal.aborted) return
      throw new Error(detailOf(error) || SAMPLE_FAILED)
    } finally {
      void context.close().catch(() => {})
    }
  })()

  return { done, stop }
}
