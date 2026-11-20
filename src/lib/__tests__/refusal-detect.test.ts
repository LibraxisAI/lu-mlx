/**
 * The refusal notice under an answer (2026-10-05).
 *
 * Measured that day: a refusal in the history is copied by better models in
 * the same chat. The app says so under the refusing answer. This file pins
 * what counts as a refusal: a SHORT answer that OPENS with a refusal phrase,
 * judged on finished model answers only, and marked once per chat.
 *
 * Run: npx vitest run src/lib/__tests__/refusal-detect.test.ts
 */
import { describe, it, expect } from 'vitest'
import { looksLikeRefusal, latestRefusalId, refusalNoticeApplies, REFUSAL_NOTICE } from '../refusal-detect'
import type { AgentBlock } from '../../types/agent-mode'
import type { Message } from '../../types/chat'

describe('looksLikeRefusal', () => {
  it.each([
    "I can't help with that request.",
    'I cannot create explicit content.',
    "I'm sorry, but I can't continue this story.",
    'I’m sorry, but I can’t assist with that.',
    "I won't write that.",
    "I'm unable to help with this.",
    'I am unable to assist with that request.',
    "I'm not comfortable writing this scene.",
    'I must decline this request.',
    "I can't engage in explicit roleplay.",
    'Sorry, but I cannot continue with this.',
    'I apologize, but I cannot generate that content.',
    'As an AI language model, I cannot create content of that nature.',
    'This is a request I am not comfortable with, so let us talk about something else.',
    '**I cannot continue this roleplay.**',
    '"I can\'t assist with that."',
  ])('a short refusal: %s', (text) => {
    expect(looksLikeRefusal(text)).toBe(true)
  })

  it('the verbatim answer of Llama 3.1 8B Turbo from the measurement', () => {
    expect(looksLikeRefusal("I can't create explicit content. Is there anything else I can help you with?")).toBe(true)
  })

  it('reasoning in a <think> block does not count towards the length', () => {
    const thought = '<think>' + 'the user asks for something I should weigh carefully '.repeat(30) + '</think>'
    expect(looksLikeRefusal(`${thought}\n\nI can't help with that.`)).toBe(true)
  })

  it('a reply that starts mid-thought and only closes the tag is read after the tag', () => {
    expect(looksLikeRefusal("weighing the request, this is not allowed</think>I cannot assist with that.")).toBe(true)
  })

  it('a refusal phrase that only stands inside the reasoning is not a refusal', () => {
    expect(looksLikeRefusal("<think>I can't help with that, or can I? Yes I can.</think>Here is the scene you asked for.")).toBe(false)
  })

  it('an answer that is still all reasoning says nothing yet', () => {
    expect(looksLikeRefusal("<think>I can't help with")).toBe(false)
  })

  it('a LONG answer that opens with the phrase is not a refusal', () => {
    const long = "I can't give you one single answer here, so let me walk through the options. " +
      'The first option is to keep the scene as it is and tighten the dialogue. '.repeat(8)
    expect(long.split(/\s+/).length).toBeGreaterThan(60)
    expect(looksLikeRefusal(long)).toBe(false)
  })

  it('a phrase in the middle of a story is not a refusal', () => {
    const story = 'The rain had not stopped for three days when Mara reached the harbour. ' +
      'She found the old keeper by the gate, and he shook his head before she had asked anything. ' +
      '"I cannot help you," he said, "the boats are gone." She laughed, because she had expected nothing else.'
    expect(looksLikeRefusal(story)).toBe(false)
  })

  it('a short story line with the phrase past the opening is not a refusal', () => {
    const text = 'The keeper looked at her for a long while, at the rain on her coat and the mud on her boots, ' +
      'at the letter in her hand that nobody in this town would ever read aloud, and then he said: "I cannot help you."'
    expect(looksLikeRefusal(text)).toBe(false)
  })

  it.each([
    'Sure, here is the scene you asked for.',
    "I can't wait to show you what I came up with!",
    "I can't believe how well that worked. Here is the next part.",
    'She cannot help but smile at him.',
    'Yes.',
    '',
    '   ',
  ])('an ordinary short answer: %s', (text) => {
    expect(looksLikeRefusal(text)).toBe(false)
  })

  it('exactly at the limit the answer is no longer short', () => {
    const fifty = "I can't help with that. " + 'word '.repeat(54)
    expect(fifty.trim().split(/\s+/).length).toBe(59)
    expect(looksLikeRefusal(fifty)).toBe(true)
    const sixty = "I can't help with that. " + 'word '.repeat(55)
    expect(sixty.trim().split(/\s+/).length).toBe(60)
    expect(looksLikeRefusal(sixty)).toBe(false)
  })
})

const REFUSAL = "I can't help with that."
let n = 0
const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id: `m${++n}`, role, content, timestamp: n, ...extra,
})

describe('latestRefusalId', () => {
  it('names the refusing answer', () => {
    const list = [msg('user', 'write it'), msg('assistant', REFUSAL)]
    expect(latestRefusalId(list)).toBe(list[1].id)
  })

  it('only the latest of several refusals', () => {
    const list = [
      msg('user', 'write it'), msg('assistant', REFUSAL),
      msg('user', 'please'), msg('assistant', "I'm sorry, but I can't continue."),
    ]
    expect(latestRefusalId(list)).toBe(list[3].id)
  })

  it('a later ordinary answer does not remove it: the refusal is still in the history', () => {
    const list = [
      msg('user', 'write it'), msg('assistant', REFUSAL),
      msg('user', 'what is 2 + 2'), msg('assistant', 'Four.'),
    ]
    expect(latestRefusalId(list)).toBe(list[1].id)
  })

  it('a chat without a refusal has none', () => {
    expect(latestRefusalId([msg('user', 'hi'), msg('assistant', 'Hello, how can I help?')])).toBeNull()
    expect(latestRefusalId([])).toBeNull()
  })

  it('the answer that is still streaming is not judged', () => {
    const list = [msg('user', 'write it'), msg('assistant', "I can't")]
    expect(latestRefusalId(list, list[1].id)).toBeNull()
    expect(latestRefusalId(list)).toBe(list[1].id)
  })

  it('an earlier refusal keeps its notice while a new answer streams', () => {
    const list = [
      msg('user', 'write it'), msg('assistant', REFUSAL),
      msg('user', 'again'), msg('assistant', "I can't"),
    ]
    expect(latestRefusalId(list, list[3].id)).toBe(list[1].id)
  })

  it('the user saying it is not a refusal of the model', () => {
    expect(latestRefusalId([msg('user', "I can't help with that.")])).toBeNull()
  })

  it('tool results, app notices, hidden rows and error sentences are not judged', () => {
    expect(latestRefusalId([msg('tool', "I cannot help with that.")])).toBeNull()
    expect(latestRefusalId([msg('system', "I cannot help with that.", { notice: 'warn' })])).toBeNull()
    expect(latestRefusalId([msg('assistant', "I cannot help with that.", { hidden: true })])).toBeNull()
    expect(latestRefusalId([msg('assistant', 'Error: the backend cannot help, connection failed')])).toBeNull()
  })
})

describe('answers of a turn that ran tools are reports, not refusals', () => {
  const FILE = "I can't find that file."
  const call = { id: 't1', toolName: 'file_read', args: {}, status: 'failed', timestamp: 1 }

  it('a tool call in the blocks of the answer', () => {
    const blocks = [{ id: 'b1', phase: 'answer', content: FILE, timestamp: 1, toolCalls: [call] }] as unknown as AgentBlock[]
    expect(latestRefusalId([msg('assistant', FILE, { agentBlocks: blocks })])).toBeNull()
  })

  it('the legacy single tool call, a tool call summary, and native tool_calls', () => {
    const legacy = [{ id: 'b1', phase: 'answer', content: FILE, timestamp: 1, toolCall: call }] as unknown as AgentBlock[]
    expect(latestRefusalId([msg('assistant', FILE, { agentBlocks: legacy })])).toBeNull()
    expect(latestRefusalId([msg('assistant', FILE, { toolCallSummary: 'file_read failed' })])).toBeNull()
    expect(latestRefusalId([msg('assistant', FILE, { tool_calls: [{ function: { name: 'file_read', arguments: {} } }] })])).toBeNull()
  })

  it('NEGATIVE CONTROL: answer blocks without any tool call are a plain answer', () => {
    // Plain chat with Chat Tools on runs through the same executor and gets
    // answer blocks too. Without a tool call it is still the model declining.
    const blocks = [{ id: 'b1', phase: 'answer', content: REFUSAL, timestamp: 1 }] as unknown as AgentBlock[]
    const list = [msg('assistant', REFUSAL, { agentBlocks: blocks })]
    expect(latestRefusalId(list)).toBe(list[0].id)
  })
})

describe('refusalNoticeApplies: only the plain chat', () => {
  it('a plain chat, hosted or local, with and without the mode written out', () => {
    expect(refusalNoticeApplies({}, false)).toBe(true)
    expect(refusalNoticeApplies({ mode: 'lu' }, false)).toBe(true)
    expect(refusalNoticeApplies({ mode: 'lu', groupModels: [] }, false)).toBe(true)
  })

  it('not in Agent mode', () => {
    expect(refusalNoticeApplies({ mode: 'lu' }, true)).toBe(false)
  })

  it('not in Code', () => {
    expect(refusalNoticeApplies({ mode: 'codex' }, false)).toBe(false)
    expect(refusalNoticeApplies({ mode: 'openclaw' }, false)).toBe(false)
  })

  it('not in a group chat', () => {
    expect(refusalNoticeApplies({ mode: 'lu', groupModels: ['a', 'b'] }, false)).toBe(false)
  })
})

describe('the wording', () => {
  it('is the sentence agreed with the web app, and names the mark of the model picker', () => {
    expect(REFUSAL_NOTICE).toBe(
      'This model declined. A refusal stays in the chat history, and other models tend to copy it. Start a new chat and pick a model marked No Filter.',
    )
  })
})
