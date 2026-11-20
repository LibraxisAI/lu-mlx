import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_VOICE_LINES,
  MAX_VOICE_TOOL_RESULT,
  VOICE_IDLE,
  latencyLabel,
  reduceVoiceSession,
  startLabel,
  startTimeout,
  VOICE_CONSENT_TIMEOUT_MS,
  VOICE_START_TIMEOUT_MS,
  WHOLE_COMPUTER_WINDOW_TITLE,
} from '../session-state'
import type { VoiceEvent, VoiceSessionState } from '../session-state'

function play(events: VoiceEvent[], from: VoiceSessionState = VOICE_IDLE): VoiceSessionState {
  return events.reduce(reduceVoiceSession, from)
}

const START: VoiceEvent = { type: 'start', at: 1000, muted: false }
const LIVE: VoiceEvent[] = [START, { type: 'start-step', step: 'engine', coldStart: true }, { type: 'ready' }]

describe('voice session: starting', () => {
  it('walks through the steps of a start and becomes live on ready', () => {
    let state = play([START])
    expect(state).toMatchObject({ phase: 'starting', startStep: 'microphone', startedAt: 1000, coldStart: false })
    state = play([{ type: 'start-step', step: 'engine', coldStart: true }], state)
    expect(state).toMatchObject({ startStep: 'engine', coldStart: true })
    state = play([{ type: 'start-step', step: 'model' }, { type: 'start-step', step: 'connecting' }], state)
    expect(state).toMatchObject({ startStep: 'connecting', coldStart: true })
    state = play([{ type: 'ready' }], state)
    expect(state).toMatchObject({ phase: 'live', startStep: null, activity: 'listening' })
  })

  it('carries the mute default into the session', () => {
    expect(play([{ type: 'start', at: 1, muted: true }]).muted).toBe(true)
  })

  it('a new start clears the last session but keeps the microphone list', () => {
    const before = play([...LIVE, { type: 'user-text', text: 'hello', final: true }, { type: 'mics', mics: [{ deviceId: 'a', label: 'A' }], micId: 'a' },
      { type: 'failed', error: { kind: 'connection-lost', message: 'lost' } }])
    const state = play([START], before)
    expect(state.lines).toEqual([])
    expect(state.error).toBeNull()
    expect(state.mics).toHaveLength(1)
    expect(state.micId).toBe('a')
  })

  it('a failed start ends in the error state with the reason', () => {
    const state = play([START, { type: 'failed', error: { kind: 'microphone-denied', message: 'blocked' } }])
    expect(state).toMatchObject({ phase: 'error', startStep: null, error: { kind: 'microphone-denied' } })
  })

  it('stopping while starting returns to idle', () => {
    const state = play([START, { type: 'stopping' }, { type: 'stopped' }])
    expect(state).toMatchObject({ phase: 'idle', startStep: null, startedAt: null })
  })

  it('a session that ended without the Stop button keeps the sentence why, until the next start', () => {
    const note = 'The session ended when you left Voice. Start again to continue.'
    const left = play([...LIVE, { type: 'stopping' }, { type: 'stopped', note }])
    expect(left).toMatchObject({ phase: 'idle', endNote: note, error: null })
    // The Stop button leaves no sentence.
    expect(play([...LIVE, { type: 'stopping' }, { type: 'stopped' }]).endNote).toBeNull()
    expect(play([START], left).endNote).toBeNull()
  })

  it('names the steps honestly, and the long cold start only when it is one', () => {
    expect(startLabel('microphone', false, 0)).toBe('Waiting for the microphone')
    expect(startLabel('engine', false, 30)).toBe('Starting voice')
    expect(startLabel('engine', true, 2)).toBe('Loading the speech models')
    expect(startLabel('engine', true, 20)).toContain('up to a minute')
    expect(startLabel('model', true, 0)).toBe('Getting the chat model ready')
    expect(startLabel('connecting', true, 0)).toBe('Connecting')
  })

  it('says what it waits for while the system asks for the whole computer', () => {
    // Windows run A22: the start stood at "Getting the chat model ready" for
    // three minutes behind a window of the system nobody had seen.
    const state = play([START, { type: 'start-step', step: 'model' }, { type: 'start-step', step: 'permission' }])
    expect(state.phase).toBe('starting')
    expect(startLabel(state.startStep, false, 12)).toBe('Waiting for your answer in the system window "Let Voice work on the whole computer?"')
  })

  it('names the window by the title Rust gives it', () => {
    const rust = readFileSync(resolve(__dirname, '../../../../src-tauri/src/commands/filesystem.rs'), 'utf8')
    expect(rust).toContain(`.set_title("${WHOLE_COMPUTER_WINDOW_TITLE}")`)
  })

  it('a start that gives up names what it waited for, and points to Repair only where something may be broken', () => {
    const waiting = startTimeout('permission')
    expect(waiting.ms).toBe(VOICE_CONSENT_TIMEOUT_MS)
    expect(waiting.message).toContain('the system window "Let Voice work on the whole computer?" was not answered')
    expect(waiting.message).not.toContain('Repair')
    expect(waiting.message).not.toContain('three minutes')
    for (const step of [null, 'microphone', 'engine', 'model', 'connecting', 'warming'] as const) {
      expect(startTimeout(step)).toEqual({ ms: VOICE_START_TIMEOUT_MS, message: 'Voice did not start within three minutes. Start it again. If this keeps happening, run Repair in the voice settings.' })
    }
    // The answer is the user's time: it gets longer than the start itself.
    expect(VOICE_CONSENT_TIMEOUT_MS).toBeGreaterThan(VOICE_START_TIMEOUT_MS)
  })
})

describe('voice session: a conversation', () => {
  it('moves through listening, hearing, thinking and speaking', () => {
    let state = play(LIVE)
    expect(state.activity).toBe('listening')
    state = play([{ type: 'user-started' }], state)
    expect(state.activity).toBe('hearing')
    state = play([{ type: 'user-stopped' }], state)
    expect(state.activity).toBe('thinking')
    state = play([{ type: 'bot-thinking' }, { type: 'bot-speaking' }], state)
    expect(state.activity).toBe('speaking')
    state = play([{ type: 'bot-silent' }], state)
    expect(state.activity).toBe('listening')
  })

  it('builds the transcript of both sides', () => {
    const state = play([
      ...LIVE,
      { type: 'user-started' },
      { type: 'user-text', text: 'what time', final: false },
      { type: 'user-text', text: 'What time is it?', final: true },
      { type: 'user-stopped' },
      { type: 'bot-thinking' },
      { type: 'bot-text', text: 'It is ' },
      { type: 'bot-speaking' },
      { type: 'bot-text', text: 'half past two.' },
      { type: 'bot-silent' },
    ])
    expect(state.lines.map(({ role, text, final }) => ({ role, text, final }))).toEqual([
      { role: 'user', text: 'What time is it?', final: true },
      { role: 'assistant', text: 'It is half past two.', final: true },
    ])
    expect(new Set(state.lines.map((l) => l.id)).size).toBe(2)
  })

  it('keeps what was said of an answer when the user speaks over it', () => {
    const state = play([
      ...LIVE,
      { type: 'user-text', text: 'Tell me a story.', final: true },
      { type: 'bot-text', text: 'Once upon a' },
      { type: 'bot-speaking' },
      { type: 'user-started' },
      { type: 'user-text', text: 'Stop.', final: true },
      { type: 'bot-text', text: 'Okay.' },
    ])
    expect(state.lines.map((l) => [l.role, l.text, l.final])).toEqual([
      ['user', 'Tell me a story.', true],
      ['assistant', 'Once upon a', true],
      ['user', 'Stop.', true],
      ['assistant', 'Okay.', false],
    ])
  })

  it('shows a sentence with a pause in it as one line', () => {
    const state = play([
      ...LIVE,
      { type: 'user-text', text: 'Please read the file', final: false },
      { type: 'user-text', text: 'Please read the file notes.', final: true },
      { type: 'user-text', text: 'and tell', final: false },
      { type: 'user-text', text: 'and tell me the code word.', final: true },
    ])
    expect(state.lines.map((l) => [l.role, l.text, l.final])).toEqual([
      ['user', 'Please read the file notes. and tell me the code word.', true],
    ])
    // The interim words of the second part replace each other, not the first part.
    const interim = play([
      ...LIVE,
      { type: 'user-text', text: 'One.', final: true },
      { type: 'user-text', text: 'tw', final: false },
      { type: 'user-text', text: 'two', final: false },
    ])
    expect(interim.lines.map((l) => [l.text, l.final])).toEqual([['One. two', false]])
  })

  it('starts a new user line once the assistant has answered', () => {
    const state = play([
      ...LIVE,
      { type: 'user-text', text: 'One.', final: true },
      { type: 'bot-text', text: 'Yes.' },
      { type: 'bot-silent' },
      { type: 'user-text', text: 'Two.', final: true },
    ])
    expect(state.lines.map((l) => l.text)).toEqual(['One.', 'Yes.', 'Two.'])
  })

  it('shows no empty lines', () => {
    const state = play([...LIVE, { type: 'user-text', text: '   ', final: true }, { type: 'bot-text', text: '' }])
    expect(state.lines).toEqual([])
  })

  it('drops an interim line that ends up empty', () => {
    const state = play([...LIVE, { type: 'user-text', text: 'uh', final: false }, { type: 'user-text', text: '', final: true }])
    expect(state.lines).toEqual([])
  })

  it('keeps the transcript bounded', () => {
    const events: VoiceEvent[] = [...LIVE]
    for (let i = 0; i < MAX_VOICE_LINES + 50; i++) events.push({ type: 'user-text', text: `line ${i}`, final: true }, { type: 'bot-text', text: 'ok' }, { type: 'bot-silent' })
    const state = play(events)
    expect(state.lines.length).toBe(MAX_VOICE_LINES)
    expect(state.lines.at(-1)?.text).toBe('ok')
  })

  it('remembers the latency of the last round only', () => {
    const state = play([...LIVE, { type: 'latency', ms: 1834.4 }, { type: 'latency', ms: 912.6 }, { type: 'latency', ms: Number.NaN }])
    expect(state.latencyMs).toBe(913)
    expect(latencyLabel(state.latencyMs)).toBe('913 ms')
    expect(latencyLabel(1834)).toBe('1.8 s')
    expect(latencyLabel(null)).toBeNull()
  })

  it('shows the notice and the model of the session', () => {
    const state = play([START, { type: 'brain', modelLabel: 'qwen', notice: 'no tools' }, { type: 'ready' }])
    expect(state).toMatchObject({ modelLabel: 'qwen', notice: 'no tools' })
  })

  it('the model of a session is not carried past its end, whether it was stopped or failed', () => {
    const live: VoiceEvent[] = [START, { type: 'brain', modelLabel: 'qwen', notice: null }, { type: 'ready' }]
    expect(play([...live, { type: 'stopping' }]).modelLabel).toBe('qwen')
    expect(play([...live, { type: 'stopping' }, { type: 'stopped' }]).modelLabel).toBeNull()
    expect(play([...live, { type: 'failed', error: { kind: 'model-error', message: 'gone' } }]).modelLabel).toBeNull()
    // A start that failed before anything was said, too.
    expect(play([START, { type: 'brain', modelLabel: 'qwen', notice: null }, { type: 'failed', error: { kind: 'start-failed', message: 'no' } }]).modelLabel).toBeNull()
  })

  it('mute changes the label of a quiet session', () => {
    const state = play([...LIVE, { type: 'muted', muted: true }])
    expect(state.muted).toBe(true)
    expect(play([{ type: 'muted', muted: false }], state).muted).toBe(false)
  })
})

describe('voice session: tools', () => {
  it('asks, runs and finishes a tool that needs approval', () => {
    let state = play([...LIVE, { type: 'tool-waiting', id: 'c1', name: 'file_write', args: { path: 'a.txt' } }])
    expect(state.approval).toEqual({ id: 'c1', name: 'file_write', args: { path: 'a.txt' } })
    expect(state.tools).toEqual([{ id: 'c1', name: 'file_write', status: 'waiting', args: { path: 'a.txt' }, after: 0 }])
    state = play([{ type: 'tool-running', id: 'c1', name: 'file_write' }], state)
    expect(state.approval).toBeNull()
    expect(state.runningTool).toBe('file_write')
    state = play([{ type: 'tool-done', id: 'c1', status: 'completed', result: 'Wrote a.txt' }], state)
    expect(state.runningTool).toBeNull()
    expect(state.tools).toEqual([{ id: 'c1', name: 'file_write', status: 'completed', args: { path: 'a.txt' }, after: 0, result: 'Wrote a.txt' }])
    expect(state.activity).toBe('thinking')
  })

  it('runs a tool that needs no approval without ever asking', () => {
    const state = play([...LIVE, { type: 'tool-running', id: 'c1', name: 'web_search', args: { query: 'weather' } }])
    expect(state.approval).toBeNull()
    expect(state.tools).toEqual([{ id: 'c1', name: 'web_search', status: 'running', args: { query: 'weather' }, after: 0 }])
  })

  it('remembers which line a tool came after, and keeps a long answer short', () => {
    const state = play([
      ...LIVE,
      { type: 'user-text', text: 'Read my notes.', final: true },
      { type: 'tool-running', id: 'c1', name: 'file_read', args: { path: 'notes.txt' } },
      { type: 'tool-done', id: 'c1', status: 'completed', result: 'x'.repeat(MAX_VOICE_TOOL_RESULT + 500) },
    ])
    expect(state.tools[0].after).toBe(state.lines[0].id)
    expect(state.tools[0].result).toHaveLength(MAX_VOICE_TOOL_RESULT)
  })

  it('marks a denied tool as rejected and clears the question', () => {
    const state = play([...LIVE, { type: 'tool-waiting', id: 'c1', name: 'shell_execute', args: {} }, { type: 'tool-done', id: 'c1', status: 'rejected' }])
    expect(state.approval).toBeNull()
    expect(state.tools[0].status).toBe('rejected')
  })

  it('keeps showing that the assistant speaks while a tool runs in the background', () => {
    const state = play([...LIVE, { type: 'bot-speaking' }, { type: 'tool-running', id: 'c1', name: 'web_search' }])
    expect(state.activity).toBe('speaking')
    expect(play([{ type: 'bot-silent' }], state).activity).toBe('tool')
  })

  it('ignores the end of a tool it never saw', () => {
    const state = play(LIVE)
    expect(play([{ type: 'tool-done', id: 'nope', status: 'completed' }], state)).toBe(state)
  })

  it('stop takes the question away and closes open tools', () => {
    const state = play([...LIVE, { type: 'tool-waiting', id: 'c1', name: 'file_write', args: {} }, { type: 'tool-running', id: 'c2', name: 'web_search' }, { type: 'stopping' }, { type: 'stopped' }])
    expect(state.phase).toBe('idle')
    expect(state.approval).toBeNull()
    expect(state.runningTool).toBeNull()
    expect(state.tools.map((t) => t.status)).toEqual(['failed', 'failed'])
  })
})

describe('voice session: the end', () => {
  it('keeps the transcript after a stop and finishes the open line', () => {
    const state = play([...LIVE, { type: 'user-text', text: 'Hi.', final: true }, { type: 'bot-text', text: 'Hel' }, { type: 'stopping' }, { type: 'stopped' }])
    expect(state.phase).toBe('idle')
    expect(state.lines.map((l) => [l.text, l.final])).toEqual([['Hi.', true], ['Hel', true]])
  })

  it('a lost connection ends a live session in the error state and keeps the transcript', () => {
    const state = play([...LIVE, { type: 'user-text', text: 'Hi.', final: true }, { type: 'failed', error: { kind: 'connection-lost', message: 'lost' } }])
    expect(state).toMatchObject({ phase: 'error', error: { kind: 'connection-lost' }, approval: null })
    expect(state.lines).toHaveLength(1)
  })

  it('ignores whatever still arrives after the session is over', () => {
    const over = play([...LIVE, { type: 'stopping' }, { type: 'stopped' }])
    const late: VoiceEvent[] = [
      { type: 'ready' }, { type: 'user-started' }, { type: 'bot-text', text: 'late' }, { type: 'bot-speaking' },
      { type: 'tool-waiting', id: 'x', name: 'file_write', args: {} }, { type: 'latency', ms: 5 },
      { type: 'failed', error: { kind: 'connection-lost', message: 'late' } },
    ]
    expect(play(late, over)).toEqual(over)
    const failed = play([...LIVE, { type: 'failed', error: { kind: 'model-error', message: 'x' } }])
    expect(play(late, failed)).toEqual(failed)
  })

  it('ignores events while stopping, except the end of the stop', () => {
    const stopping = play([...LIVE, { type: 'stopping' }])
    expect(play([{ type: 'bot-text', text: 'late' }, { type: 'user-started' }], stopping)).toEqual(stopping)
    expect(play([{ type: 'stopped' }], stopping).phase).toBe('idle')
  })

  it('does not become live from idle on a stray ready', () => {
    expect(play([{ type: 'ready' }]).phase).toBe('idle')
  })
})

describe('voice session: getting ready and screen tasks', () => {
  it('names the warm up of a local model, and explains a long one', () => {
    const state = play([START, { type: 'start-step', step: 'warming', coldStart: false }])
    expect(state.startStep).toBe('warming')
    expect(startLabel('warming', false, 2)).toBe('Getting ready')
    expect(startLabel('warming', false, 25)).toContain('reads its instructions once')
  })

  it('keeps what is said while a local model warms up, and waits for its answer at ready', () => {
    let state = play([START, { type: 'start-step', step: 'connecting' }, { type: 'user-text', text: 'too early', final: true }])
    expect(state.lines).toEqual([])
    state = play([{ type: 'start-step', step: 'warming' }, { type: 'user-text', text: 'What time is it?', final: true }], state)
    expect(state.phase).toBe('starting')
    expect(state.lines.map((line) => `${line.role}: ${line.text}`)).toEqual(['user: What time is it?'])
    state = play([{ type: 'ready' }], state)
    expect(state).toMatchObject({ phase: 'live', activity: 'thinking' })
    state = play([{ type: 'bot-text', text: 'Ten past four.' }], state)
    expect(state.lines.map((line) => line.role)).toEqual(['user', 'assistant'])
    expect(play([START, { type: 'start-step', step: 'warming' }, { type: 'ready' }]).activity).toBe('listening')
  })
})

describe('voice session: what the model thinks', () => {
  it('collects a thought into one line of its own, before the answer', () => {
    const state = play([...LIVE, { type: 'user-text', text: 'Why is the sky blue?', final: true },
      { type: 'thought-text', text: 'Rayleigh ' }, { type: 'thought-text', text: 'scattering.' },
      { type: 'thought-end', secs: 3.4 }, { type: 'bot-text', text: 'Because of how air scatters light.' }])
    expect(state.lines.map((line) => [line.role, line.text, line.final])).toEqual([
      ['user', 'Why is the sky blue?', true],
      ['thought', 'Rayleigh scattering.', true],
      ['assistant', 'Because of how air scatters light.', false],
    ])
    expect(state.lines[1]).toMatchObject({ secs: 3.4 })
    expect(state.lines[1].cut).toBeUndefined()
  })

  it('marks a thought that was ended at the length the user set', () => {
    const state = play([...LIVE, { type: 'thought-text', text: 'On and on' }, { type: 'thought-end', secs: 9, cut: true }])
    expect(state.lines[0]).toMatchObject({ role: 'thought', final: true, cut: true, secs: 9 })
  })

  it('starts a new thought line after the first one is over', () => {
    const state = play([...LIVE, { type: 'thought-text', text: 'one' }, { type: 'thought-end' }, { type: 'thought-text', text: 'two' }])
    expect(state.lines.map((line) => [line.role, line.text, line.final])).toEqual([['thought', 'one', true], ['thought', 'two', false]])
  })

  it('ignores the end of a thought that never began', () => {
    const before = play(LIVE)
    expect(play([{ type: 'thought-end', secs: 1 }], before)).toBe(before)
  })
})
