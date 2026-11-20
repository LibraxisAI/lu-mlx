// @vitest-environment jsdom
/**
 * The notice under a refusing answer (2026-10-05).
 *
 * Measured that day: a refusal in the history is copied by better models in
 * the same chat. The chat says so directly UNDER the refusing answer, with a
 * warning triangle and a "New chat" button that opens a new chat on the same
 * model. Same in Cloud and in local chat. Nothing of it stands in or above
 * the prompt field: the line belongs to the transcript.
 *
 * What counts as a refusal is pinned in lib/__tests__/refusal-detect.test.ts.
 *
 * Run: npx vitest run src/components/chat/__tests__/eine-ablehnung-bekommt-ihren-hinweis.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MessageList } from '../MessageList'
import { useChatStore } from '../../../stores/chatStore'
import { useModelStore } from '../../../stores/modelStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { BUILT_IN_PERSONAS, DEFAULT_SETTINGS } from '../../../lib/constants'
import type { AIModel } from '../../../types/models'
import type { Message } from '../../../types/chat'

const LOCAL = 'openai::Qwen3-14B-Q4_K_M'
const CLOUD = 'lu-cloud::llama-3.1-8b-turbo'
const NOTICE =
  'This model declined. A refusal stays in the chat history, and other models tend to copy it. Start a new chat and pick a model marked No Filter.'
const REFUSAL = "I can't create explicit content. Is there anything else I can help you with?"

const textModel = (name: string): AIModel => ({ name, type: 'text' } as AIModel)
let n = 0
const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id: `m${++n}`, role, content, timestamp: n, ...extra,
})

let convId = ''
function chatWith(model: string, messages: Message[]) {
  useModelStore.setState({ models: [textModel(LOCAL), textModel(CLOUD)], activeModel: model })
  convId = useChatStore.getState().createConversation(model, '')
  useChatStore.setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === convId ? { ...c, messages } : c)),
  }))
}

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, personas: [...BUILT_IN_PERSONAS] })
  useAgentModeStore.setState({ agentModeActive: {} })
})
afterEach(cleanup)

const notices = () => screen.queryAllByTestId('refusal-notice')

describe.each([
  ['a local chat', LOCAL],
  ['a Cloud chat', CLOUD],
])('%s', (_name, model) => {
  it('shows the notice under the refusing answer, word for word, with the button', () => {
    chatWith(model, [msg('user', 'write the scene'), msg('assistant', REFUSAL)])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(1)
    expect(notices()[0].textContent).toBe(`${NOTICE} New chat`)
    expect(within(notices()[0]).getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(notices()[0].querySelector('svg')).not.toBeNull()
  })

  it('"New chat" opens an empty chat on the same model and leaves the old one as it is', () => {
    chatWith(model, [msg('user', 'write the scene'), msg('assistant', REFUSAL)])
    render(<MessageList isGenerating={false} />)
    fireEvent.click(within(notices()[0]).getByRole('button', { name: 'New chat' }))
    const { conversations, activeConversationId } = useChatStore.getState()
    expect(conversations).toHaveLength(2)
    expect(activeConversationId).not.toBe(convId)
    const fresh = conversations.find((c) => c.id === activeConversationId)!
    expect(fresh.model).toBe(model)
    expect(fresh.messages).toHaveLength(0)
    expect(conversations.find((c) => c.id === convId)!.messages).toHaveLength(2)
    expect(useModelStore.getState().activeModel).toBe(model)
    // The new chat has no refusal in it, so the line is gone with the old one.
    expect(notices()).toHaveLength(0)
  })
})

describe('where the notice stands', () => {
  it('sits inside the transcript row of the refusing answer, after its text', () => {
    chatWith(LOCAL, [msg('user', 'write the scene'), msg('assistant', REFUSAL)])
    const { container } = render(<MessageList isGenerating={false} />)
    const answer = screen.getByText(REFUSAL)
    const notice = notices()[0]
    expect(answer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('only at the latest refusal of the chat', () => {
    const second = msg('assistant', "I'm sorry, but I can't continue this story.")
    chatWith(LOCAL, [msg('user', 'write the scene'), msg('assistant', REFUSAL), msg('user', 'please'), second])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(1)
    const answer = screen.getByText(second.content)
    expect(answer.compareDocumentPosition(notices()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stays when a later answer is an ordinary one: the refusal is still in the history', () => {
    chatWith(LOCAL, [
      msg('user', 'write the scene'), msg('assistant', REFUSAL),
      msg('user', 'what is 2 + 2'), msg('assistant', 'Four.'),
    ])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(1)
  })
})

describe('what gets no notice', () => {
  it('an ordinary answer', () => {
    chatWith(LOCAL, [msg('user', 'hi'), msg('assistant', 'Hello, how can I help?')])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })

  it('an answer that is still streaming, even when it begins like a refusal', () => {
    chatWith(LOCAL, [msg('user', 'write the scene'), msg('assistant', "I can't")])
    render(<MessageList isGenerating isThisChatGenerating />)
    expect(notices()).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: the same answer once the stream is over', () => {
    chatWith(LOCAL, [msg('user', 'write the scene'), msg('assistant', "I can't")])
    render(<MessageList isGenerating={false} isThisChatGenerating={false} />)
    expect(notices()).toHaveLength(1)
  })

  it('a long answer that opens with the phrase', () => {
    const long = "I can't give you one single answer here, so let me walk through the options. " +
      'The first option is to keep the scene as it is and tighten the dialogue. '.repeat(8)
    chatWith(LOCAL, [msg('user', 'help me'), msg('assistant', long)])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })

  it('an error sentence of the app and an app notice', () => {
    chatWith(LOCAL, [
      msg('user', 'hi'),
      msg('assistant', 'Error: the backend cannot help, connection failed'),
      msg('system', "I cannot help with that.", { notice: 'warn' }),
    ])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })
})

describe('only the plain chat: Agent, Code and group chats get no notice', () => {
  // "I can't find that file" is a report about a tool, not a refusal of the
  // request, and it is exactly as short and opens exactly the same way.
  const FILE = "I can't find that file."

  it('NEGATIVE CONTROL: the same sentence in a plain chat is marked', () => {
    chatWith(LOCAL, [msg('user', 'read notes.txt'), msg('assistant', FILE)])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(1)
  })

  it('Agent mode on for this chat: no notice, for a tool report or a real refusal', () => {
    chatWith(LOCAL, [msg('user', 'read notes.txt'), msg('assistant', FILE), msg('user', 'write it'), msg('assistant', REFUSAL)])
    useAgentModeStore.setState({ agentModeActive: { [convId]: true } })
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })

  it('Agent mode on in ANOTHER chat does not silence this one', () => {
    chatWith(LOCAL, [msg('user', 'write it'), msg('assistant', REFUSAL)])
    useAgentModeStore.setState({ agentModeActive: { 'some-other-chat': true } })
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(1)
  })

  it('an answer of a turn that ran a tool, with Agent mode off again', () => {
    const blocks = [{
      id: 'b1', phase: 'answer', content: FILE, timestamp: 1,
      toolCalls: [{ id: 't1', toolName: 'file_read', args: { path: 'notes.txt' }, status: 'failed', timestamp: 1 }],
    }] as unknown as Message['agentBlocks']
    chatWith(LOCAL, [msg('user', 'read notes.txt'), msg('assistant', FILE, { agentBlocks: blocks })])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })

  it('a Code conversation', () => {
    chatWith(LOCAL, [msg('user', 'fix the bug'), msg('assistant', FILE)])
    useChatStore.setState((s) => ({
      conversations: s.conversations.map((c) => (c.id === convId ? { ...c, mode: 'codex' as const } : c)),
    }))
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })

  it('the Code transcript does not draw the notice at all', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const codex = readFileSync(resolve(here, '../CodexView.tsx'), 'utf8')
    expect(codex).not.toContain('RefusalNotice')
    expect(codex).not.toContain('refusal-detect')
  })

  it('a group chat', () => {
    chatWith(LOCAL, [msg('user', 'write it'), msg('assistant', REFUSAL, { modelId: LOCAL })])
    useChatStore.getState().setGroupModels(convId, [LOCAL, CLOUD])
    render(<MessageList isGenerating={false} />)
    expect(notices()).toHaveLength(0)
  })
})

describe('"New chat" without a picked model', () => {
  it('opens the landing page instead of a chat on no model', () => {
    chatWith(CLOUD, [msg('user', 'write the scene'), msg('assistant', REFUSAL)])
    useModelStore.setState({ activeModel: null })
    render(<MessageList isGenerating={false} />)
    fireEvent.click(within(notices()[0]).getByRole('button', { name: 'New chat' }))
    expect(useChatStore.getState().activeConversationId).toBeNull()
    expect(useChatStore.getState().conversations).toHaveLength(1)
  })
})
