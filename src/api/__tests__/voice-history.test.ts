import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chatStore'
import { VoiceHistory, voiceModelRecord } from '../voice-history'
import { conversationModel, conversationModelDiffers } from '../../lib/conversation-model'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const extract = vi.fn(async () => {})

function open() {
  const conversationId = useChatStore.getState().createConversation('ollama::qwen', '')
  const history = new VoiceHistory({ conversationId, modelId: 'qwen', memoryScope: 'project-a', extract })
  const messages = () => useChatStore.getState().conversations.find((c) => c.id === conversationId)?.messages ?? []
  return { conversationId, history, messages }
}

beforeEach(() => {
  vi.useFakeTimers()
  extract.mockClear()
  useChatStore.setState({ conversations: [], activeConversationId: null })
})
afterEach(() => { vi.useRealTimers() })

describe('VoiceHistory', () => {
  it('writes a spoken exchange as a normal conversation', () => {
    const { history, messages, conversationId } = open()
    history.userSaid('What time is it?')
    history.botText('It is ')
    history.botText('half past two.')
    history.botTurnEnded()
    expect(messages().map((m) => [m.role, m.content])).toEqual([
      ['user', 'What time is it?'],
      ['assistant', 'It is half past two.'],
    ])
    expect(messages()[1].modelId).toBe('qwen')
    // The first sentence names the chat, like a typed one does.
    expect(useChatStore.getState().conversations.find((c) => c.id === conversationId)?.title).toContain('What time is it')
  })

  it('writes streamed text in intervals, not on every token', () => {
    const { history, messages } = open()
    history.userSaid('Hi.')
    const update = vi.spyOn(useChatStore.getState(), 'updateMessageContent')
    for (let i = 0; i < 50; i++) history.botText('a')
    expect(messages()[1].content).toBe('')
    vi.advanceTimersByTime(300)
    expect(messages()[1].content).toBe('a'.repeat(50))
    update.mockRestore()
  })

  it('joins two transcripts of one sentence into one user message', () => {
    const { history, messages } = open()
    history.userSaid('Open the file')
    history.userSaid('called notes.')
    expect(messages().map((m) => m.content)).toEqual(['Open the file called notes.'])
  })

  it('starts a new answer after the user spoke again', () => {
    const { history, messages } = open()
    history.userSaid('One.')
    history.botText('First.')
    history.userSaid('Two.')
    history.botText('Second.')
    history.botTurnEnded()
    expect(messages().map((m) => m.content)).toEqual(['One.', 'First.', 'Two.', 'Second.'])
  })

  it('records a tool call as the block the agent chat draws', () => {
    const { history, messages } = open()
    history.userSaid('Write a note.')
    history.botText('I will write the note now.')
    history.toolEvent({ type: 'approval', id: 'call-1', name: 'file_write', args: { path: 'note.txt' } })
    let block = messages()[1].agentBlocks![0]
    expect(block).toMatchObject({ id: 'call-1', phase: 'tool_call', content: 'Requesting approval: file_write' })
    expect(block.toolCalls![0]).toMatchObject({ toolName: 'file_write', status: 'pending_approval', args: { path: 'note.txt' } })

    history.toolEvent({ type: 'started', id: 'call-1', name: 'file_write', args: { path: 'note.txt' } })
    expect(messages()[1].agentBlocks![0].toolCalls![0].status).toBe('running')

    history.toolEvent({ type: 'finished', id: 'call-1', name: 'file_write', args: { path: 'note.txt' }, status: 'completed', result: 'Wrote note.txt', durationMs: 42 })
    block = messages()[1].agentBlocks![0]
    expect(messages()[1].agentBlocks).toHaveLength(1)
    expect(block.content).toBe('Completed: file_write')
    expect(block.toolCalls![0]).toMatchObject({ status: 'completed', result: 'Wrote note.txt', duration: 42 })
    expect(block.toolCall).toEqual(block.toolCalls![0])
    expect(messages()[1].content).toBe('I will write the note now.')
  })

  it('keeps a slow tool with the answer it was called in, also when the user spoke meanwhile', () => {
    const { history, messages } = open()
    history.userSaid('Search for it.')
    history.toolEvent({ type: 'started', id: 'c1', name: 'web_search', args: {} })
    history.userSaid('And hurry.')
    history.botText('On it.')
    history.toolEvent({ type: 'finished', id: 'c1', name: 'web_search', args: {}, status: 'failed', result: 'timed out', durationMs: 5 })
    const all = messages()
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(all[1].agentBlocks![0]).toMatchObject({ content: 'Failed: web_search' })
    expect(all[1].agentBlocks![0].toolCalls![0]).toMatchObject({ status: 'failed', error: 'timed out' })
    expect(all[3].agentBlocks ?? []).toEqual([])
  })

  it('marks a denied call as rejected', () => {
    const { history, messages } = open()
    history.userSaid('Delete it.')
    history.toolEvent({ type: 'approval', id: 'c1', name: 'shell_execute', args: { command: 'rm x' } })
    history.toolEvent({ type: 'finished', id: 'c1', name: 'shell_execute', args: { command: 'rm x' }, status: 'rejected', durationMs: 1 })
    expect(messages()[1].agentBlocks![0].content).toBe('Rejected: shell_execute')
    expect(messages()[1].agentBlocks![0].toolCalls![0].status).toBe('rejected')
  })

  it('removes the conversation of a session in which nothing was said', () => {
    const { history, conversationId } = open()
    history.finish()
    expect(useChatStore.getState().conversations.some((c) => c.id === conversationId)).toBe(false)
    expect(extract).not.toHaveBeenCalled()
  })

  it('hands the whole session to the memory extraction once, as a voice source', () => {
    const { history, conversationId } = open()
    history.userSaid('My name is David.')
    history.botText('Nice to meet you, David.')
    history.userSaid('I live in Berlin.')
    history.botText('Berlin, noted.')
    history.finish()
    history.finish()
    expect(extract).toHaveBeenCalledTimes(1)
    expect(extract).toHaveBeenCalledWith(
      'My name is David.\nI live in Berlin.',
      'Nice to meet you, David.\nBerlin, noted.',
      conversationId,
      { scope: 'project-a', sourceKind: 'voice', digest: true },
    )
  })

  it('keeps a conversation that has only a user sentence, without an extraction', () => {
    const { history, conversationId } = open()
    history.userSaid('Hello?')
    history.finish()
    expect(useChatStore.getState().conversations.some((c) => c.id === conversationId)).toBe(true)
    expect(extract).not.toHaveBeenCalled()
  })

  it('writes nothing after the session ended', () => {
    const { history, messages } = open()
    history.userSaid('Hi.')
    history.finish()
    history.userSaid('late')
    history.botText('late')
    history.toolEvent({ type: 'started', id: 'x', name: 'web_search', args: {} })
    expect(messages().map((m) => m.content)).toEqual(['Hi.'])
  })
})

describe('VoiceHistory and the screen', () => {
  it('leaves what the assistant read from the screen out of the memory extraction', () => {
    const { history, conversationId } = open()
    history.userSaid('My name is David.')
    history.botText('Nice to meet you, David.')
    history.botTurnEnded()
    history.userSaid('Read me the open mail.')
    history.botText('I will look.')
    history.toolEvent({ type: 'started', id: 'c1', name: 'computer_task', args: { goal: 'read the mail' } })
    history.botTurnEnded()
    history.toolEvent({ type: 'finished', id: 'c1', name: 'computer_task', args: { goal: 'read the mail' }, status: 'completed', result: 'Mail from Anna Example about her diagnosis.', durationMs: 9000 })
    history.botText('Anna Example writes about her diagnosis.')
    history.botTurnEnded()
    history.finish()
    expect(extract).toHaveBeenCalledTimes(1)
    const [user, assistant, id, options] = extract.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>]
    expect(user).toBe('My name is David.\nRead me the open mail.')
    expect(assistant).toBe('Nice to meet you, David.')
    expect(assistant).not.toContain('Anna')
    expect(id).toBe(conversationId)
    expect(options).toMatchObject({ sourceKind: 'voice', digest: true })
  })

  it('still remembers what the user said when every answer was about the screen', () => {
    const { history } = open()
    history.userSaid('Remember that I like tea. What is on my screen?')
    history.toolEvent({ type: 'started', id: 'c1', name: 'computer_task', args: {} })
    history.toolEvent({ type: 'finished', id: 'c1', name: 'computer_task', args: {}, status: 'completed', result: 'A bank statement.', durationMs: 5 })
    history.botText('A bank statement with the balance 1200.')
    history.finish()
    const [user, assistant] = extract.mock.calls[0] as unknown as [string, string]
    expect(user).toContain('I like tea')
    expect(assistant).not.toContain('1200')
    expect(assistant).toContain('What it saw there is not part of this record')
  })

  it('counts answers again once the user has moved on', () => {
    const { history } = open()
    history.userSaid('What is on my screen?')
    history.toolEvent({ type: 'started', id: 'c1', name: 'computer_task', args: {} })
    history.toolEvent({ type: 'finished', id: 'c1', name: 'computer_task', args: {}, status: 'completed', result: 'A page.', durationMs: 5 })
    history.botText('A page about cats.')
    history.botTurnEnded()
    history.userSaid('I moved to Hamburg.')
    history.botText('Hamburg, noted.')
    history.finish()
    const [, assistant] = extract.mock.calls[0] as unknown as [string, string]
    expect(assistant).toBe('Hamburg, noted.')
  })

  it('keeps what the model thought with the answer, in the field the chat shows as Thinking, and not in its text', () => {
    const { history, messages } = open()
    history.userSaid('Why is the sky blue?')
    history.botThought('Rayleigh ')
    history.botThought('scattering.')
    history.botText('Because air scatters blue light most.')
    history.botTurnEnded()
    expect(messages()[1].content).toBe('Because air scatters blue light most.')
    expect(messages()[1].thinking).toBe('Rayleigh scattering.')
  })
})

describe('the model a voice answer records', () => {
  /** A session on `picked`, of which the voice loop was handed `providerId` and the bare `model`. */
  function sessionOn(picked: string, providerId: string, model: string, modelId = voiceModelRecord(providerId, model)) {
    const conversationId = useChatStore.getState().createConversation(picked, '')
    const history = new VoiceHistory({ conversationId, modelId, extract })
    history.userSaid('Hello.')
    history.botText('Hello to you.')
    history.botTurnEnded()
    return useChatStore.getState().conversations.find((c) => c.id === conversationId)!
  }

  it.each([
    ['the app\'s own engine', 'openai::Qwen3.5-9B-Q4_K_M', 'openai', 'Qwen3.5-9B-Q4_K_M'],
    ['a hosted model', 'lu-cloud::moonshotai/Kimi-K2.6', 'lu-cloud', 'moonshotai/Kimi-K2.6'],
    ['a model in Ollama', 'qwen3:8b', 'ollama', 'qwen3:8b'],
  ])('%s: the conversation reads as written by the model that is picked, so the picker marks nothing', (_name, picked, providerId, model) => {
    const conversation = sessionOn(picked, providerId, model)
    expect(conversationModel(conversation)).toBe(picked)
    expect(conversationModelDiffers(conversation, picked)).toBe(false)
    // Another model picked later is another model, and the conversation still names its own.
    expect(conversationModelDiffers(conversation, 'openai::another-model')).toBe(true)
    expect(conversationModel(conversation)).toBe(picked)
  })

  it('recorded bare, as before 3.0.6, the same conversation read as written by another model', () => {
    const picked = 'openai::Qwen3.5-9B-Q4_K_M'
    expect(conversationModelDiffers(sessionOn(picked, 'openai', 'Qwen3.5-9B-Q4_K_M', 'Qwen3.5-9B-Q4_K_M'), picked)).toBe(true)
  })

  it('the session hands the history that record', () => {
    const source = readFileSync(resolve(__dirname, '..', 'voice-session.ts'), 'utf8')
    expect(source).toContain('modelId: voiceModelRecord(brain.providerId, brain.llm.model)')
  })
})
