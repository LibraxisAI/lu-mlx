/**
 * Only a fatal error of the voice loop ends the session.
 *
 * Run: npx vitest run src/lib/voice/__tests__/loop-errors.test.ts
 */
import { describe, it, expect } from 'vitest'
import { HEARING_FAILED_HINT, SPEECH_FAILED_HINT, readLoopError } from '../loop-errors'
import { VOICE_IDLE, reduceVoiceSession } from '../session-state'
import type { VoiceEvent } from '../session-state'

const clean = (text: unknown) => (typeof text === 'string' ? text.replace('sk-secret', '[key]').trim() : '')

describe('an error the voice loop reports', () => {
  it('a fatal one ends the session and carries the words of the voice loop', () => {
    expect(readLoopError({ error: 'The pipeline stopped.', fatal: true }, clean)).toEqual({ fatal: true, detail: 'The pipeline stopped.', hint: null })
  })

  it('one sentence that could not be spoken does not: the user is told that it is missing', () => {
    expect(readLoopError({ error: 'Speech synthesis failed (ValueError).', fatal: false }, clean)).toEqual({
      fatal: false, detail: 'Speech synthesis failed (ValueError).', hint: SPEECH_FAILED_HINT,
    })
  })

  it('one utterance that could not be recognized does not either', () => {
    expect(readLoopError({ error: 'Speech recognition failed (RuntimeError).', fatal: false }, clean).hint).toBe(HEARING_FAILED_HINT)
  })

  it('a request limit is shown in the sentence of the model server, whole and without a frame', () => {
    const said = 'Qwen 3.8 Plus is at its request limit right now. Please send your message again in about 12 seconds, or pick a different model. Nothing was charged.'
    expect(said.length).toBeGreaterThan(140)
    expect(readLoopError({ error: `Request limit: ${said}`, fatal: false }, clean)).toEqual({
      fatal: false, detail: `Request limit: ${said}`, hint: said,
    })
  })

  it('a request limit without a sentence gets ours, which says nothing about an account or a charge', () => {
    for (const error of ['Request limit:', 'Request limit: Too Many Requests']) {
      expect(readLoopError({ error, fatal: false }, clean).hint)
        .toBe('The server is limiting requests right now. Please wait a moment, then ask again.')
    }
  })

  it('any other error that is not fatal is shown in the words of the voice loop, short and without a key', () => {
    const read = readLoopError({ error: `Error during completion: key sk-secret refused. ${'x'.repeat(400)}`, fatal: false }, clean)
    expect(read.fatal).toBe(false)
    expect(read.hint).toMatch(/^Something went wrong: Error during completion: key \[key\] refused\. x+\.\.\. The session goes on\.$/)
    expect(read.hint!.length).toBeLessThan(200)
    expect(readLoopError({ error: 'The model server answered 503.', fatal: false }, clean).hint).toBe('Something went wrong: The model server answered 503. The session goes on.')
  })

  it('the older field of the protocol is still read', () => {
    expect(readLoopError({ message: 'Speech synthesis failed (ValueError).', fatal: false }, clean).hint).toBe(SPEECH_FAILED_HINT)
  })

  it('without the mark of the protocol the app does not guess that the session survived', () => {
    for (const data of [{ error: 'Something.' }, { error: 'Something.', fatal: 'false' }, null, 'text', undefined]) {
      expect(readLoopError(data, clean).fatal).toBe(true)
    }
  })

  it('an error without words is not fatal by itself and shows nothing', () => {
    expect(readLoopError({ fatal: false }, clean)).toEqual({ fatal: false, detail: '', hint: null })
  })
})

describe('the hint in a running session', () => {
  const play = (events: VoiceEvent[]) => events.reduce(reduceVoiceSession, VOICE_IDLE)
  const LIVE: VoiceEvent[] = [{ type: 'start', at: 1, muted: false }, { type: 'ready' }]

  it('stands under the status while the session stays live, and leaves when the user speaks again', () => {
    let state = play([...LIVE, { type: 'hint', text: SPEECH_FAILED_HINT }])
    expect(state.phase).toBe('live')
    expect(state.error).toBeNull()
    expect(state.hint).toBe(SPEECH_FAILED_HINT)
    state = reduceVoiceSession(state, { type: 'user-started' })
    expect(state.hint).toBeNull()
  })

  it('is nothing outside of a running session, and a new session starts without one', () => {
    expect(play([{ type: 'hint', text: 'x' }]).hint).toBeNull()
    expect(play([...LIVE, { type: 'hint', text: 'x' }, { type: 'stopped' }, { type: 'start', at: 2, muted: false }]).hint).toBeNull()
  })
})
