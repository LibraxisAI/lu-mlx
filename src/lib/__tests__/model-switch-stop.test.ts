import { describe, it, expect, beforeEach } from 'vitest'
import { useGenerationStore } from '../../stores/generationStore'
import {
  MODEL_SWITCH_FINISH,
  __resetModelSwitchStopsForTests,
  beginModelSwitchWatch,
  cutByModelSwitch,
  finishReasonAfterSwitch,
  noteModelSwitch,
} from '../model-switch-stop'
import { emptyAnswerExplanation, truncationNotice } from '../answer-notes'

const T0 = 1_000_000

beforeEach(() => {
  __resetModelSwitchStopsForTests()
  useGenerationStore.setState({ runs: {}, generating: {}, aborters: {} })
})

describe('an answer that loses its engine to a model switch', () => {
  it('a run on the local lane is marked by the switch', () => {
    useGenerationStore.getState().bookRun('chat-1', 'local')
    expect(cutByModelSwitch('chat-1', T0)).toBe(false)
    noteModelSwitch(T0)
    expect(cutByModelSwitch('chat-1', T0 + 500)).toBe(true)
  })

  it('a run on a hosted model is not: it holds no local engine', () => {
    useGenerationStore.getState().bookRun('chat-cloud', 'cloud')
    noteModelSwitch(T0)
    expect(cutByModelSwitch('chat-cloud', T0 + 500)).toBe(false)
  })

  it('a conversation that was not running at the switch is not marked', () => {
    noteModelSwitch(T0)
    useGenerationStore.getState().bookRun('chat-later', 'local')
    expect(cutByModelSwitch('chat-later', T0 + 500)).toBe(false)
  })

  it('the next run on the same conversation starts without the old mark', () => {
    useGenerationStore.getState().bookRun('chat-1', 'local')
    noteModelSwitch(T0)
    beginModelSwitchWatch('chat-1')
    expect(cutByModelSwitch('chat-1', T0 + 500)).toBe(false)
  })

  it('a failure long after the switch keeps its own reason', () => {
    useGenerationStore.getState().bookRun('chat-1', 'local')
    noteModelSwitch(T0)
    expect(cutByModelSwitch('chat-1', T0 + 30_000)).toBe(true)
    expect(cutByModelSwitch('chat-1', T0 + 30_001)).toBe(false)
  })

  it('only a dropped connection is read as the switch, a length cut stays one', () => {
    useGenerationStore.getState().bookRun('chat-1', 'local')
    expect(finishReasonAfterSwitch('disconnect', 'chat-1')).toBe('disconnect')
    noteModelSwitch()
    expect(finishReasonAfterSwitch('disconnect', 'chat-1')).toBe(MODEL_SWITCH_FINISH)
    expect(finishReasonAfterSwitch('length', 'chat-1')).toBe('length')
    expect(finishReasonAfterSwitch('stop', 'chat-1')).toBe('stop')
  })

  it('no conversation, no mark', () => {
    noteModelSwitch(T0)
    expect(cutByModelSwitch(null, T0)).toBe(false)
    expect(cutByModelSwitch(undefined, T0)).toBe(false)
  })
})

describe('what the answer says', () => {
  it('the marker under a cut answer names the switch', () => {
    expect(truncationNotice(MODEL_SWITCH_FINISH)).toBe('Stopped because you switched to another model')
  })

  it('an answer that had not started says so in a sentence, and not that the network failed', () => {
    const line = emptyAnswerExplanation({ finishReason: MODEL_SWITCH_FINISH, captured: false, keepThinking: false })
    expect(line).toMatch(/^Stopped because you switched to another model/)
    expect(line).not.toMatch(/network|connection/i)
  })
})
