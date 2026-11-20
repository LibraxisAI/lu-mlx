import { describe, expect, it } from 'vitest'
import { AnswerGate } from '../answer-gate'
import { VOICE_IDLE, reduceVoiceSession as reduceVoice, type VoiceSessionState } from '../session-state'

describe('AnswerGate', () => {
  it('lets the text of a response through', () => {
    const gate = new AnswerGate()
    expect(gate.accepts()).toBe(true)
    gate.responseStarted()
    expect(gate.accepts()).toBe(true)
  })

  it('drops what a cancelled response still sends, until the next response starts', () => {
    const gate = new AnswerGate()
    gate.responseStarted()
    gate.userStarted()
    expect(gate.accepts()).toBe(false)
    gate.responseStarted()
    expect(gate.accepts()).toBe(true)
  })

  it('keeps a late token of the interrupted answer out of the transcript', () => {
    // The order seen in the real Windows build: the question came with a
    // pause in it, the first half was answered, the second half cut in.
    const gate = new AnswerGate()
    let state: VoiceSessionState = { ...VOICE_IDLE, phase: 'live' }
    const text = (t: string) => { if (gate.accepts()) state = reduceVoice(state, { type: 'bot-text', text: t }) }
    state = reduceVoice(state, { type: 'user-text', text: 'What is the capital of France?', final: true })
    gate.responseStarted()
    text('The')
    gate.userStarted()
    state = reduceVoice(state, { type: 'user-started' })
    text(' capital')
    state = reduceVoice(state, { type: 'user-text', text: 'Answer in one short sentence.', final: true })
    gate.responseStarted()
    text('The capital of France is Paris.')
    expect(state.lines.map((l) => `${l.role}:${l.text}`)).toEqual([
      'user:What is the capital of France?',
      'assistant:The',
      'user:Answer in one short sentence.',
      'assistant:The capital of France is Paris.',
    ])
  })
})
