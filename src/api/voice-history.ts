// A voice session, written into the chat history.
//
// What is said in a voice session becomes a normal conversation: the user's
// sentences as user messages, the answers as assistant messages, tool calls
// as the same blocks the agent chat draws. The session can be read again
// under Chat, continued by typing, exported and deleted like any other.
//
// The conversation is created when the session starts, because tools need a
// conversation to run in (permissions and the workspace folder are per
// conversation). A session in which nothing was said removes it again, so an
// accidental Start leaves no empty chat behind.

import { v4 as uuid } from 'uuid'
import type { AgentBlock, AgentToolCall } from '../types/agent-mode'
import type { Message } from '../types/chat'
import { useChatStore } from '../stores/chatStore'
import { extractMemoriesFromPair } from '../hooks/useMemory'
import type { VoiceToolEvent } from './voice-tool-bridge'
import { prefixModelName } from './providers/model-name'
import type { ProviderId } from './providers/types'
import { SCREEN_RUN_STAND_IN, SCREEN_TOOLS } from '../lib/computer/memory-policy'

/** How often streamed answer text is written to the chat store. */
const FLUSH_MS = 250
/** The most text of a session that is handed to the memory extraction. */
const DIGEST_CHARS = 6000

interface OpenAnswer {
  messageId: string
  content: string
  /** What the model thought before this answer, as the chat keeps it. */
  thinking: string
  blocks: AgentBlock[]
  dirty: boolean
  /** A tool of this answer looked at the screen. */
  sawScreen: boolean
}

/**
 * The model a session talks to, as its answers record it: the name the picker
 * and the chat use, with the provider in it. The voice loop itself is handed
 * the bare id (`llm.model`). Recorded bare, an answer from the app's own
 * engine or from a hosted model read as written by another model than the
 * one picked, and the picker marked the conversation for it
 * (lib/conversation-model.ts).
 */
export function voiceModelRecord(providerId: string, model: string): string {
  return prefixModelName(providerId as ProviderId, model)
}

export interface VoiceHistoryOptions {
  conversationId: string
  /** The model recorded on every answer, as the chat records it (`voiceModelRecord`). */
  modelId: string
  memoryScope?: string
  /** Replaced in tests. */
  extract?: typeof extractMemoriesFromPair
}

export class VoiceHistory {
  readonly conversationId: string
  private readonly modelId: string
  private readonly memoryScope: string | undefined
  private readonly extract: typeof extractMemoriesFromPair
  private answer: OpenAnswer | null = null
  /** Which answer a tool call was drawn in, by the call's id. */
  private readonly callHome = new Map<string, OpenAnswer>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private userWords: string[] = []
  private answerWords: string[] = []
  private wrote = false
  private finished = false
  /** Some answer of this session reported on the screen. */
  private sawScreen = false
  /** Answers opened now may describe the screen: a screen tool runs or just reported. */
  private screenTalk = false

  constructor(options: VoiceHistoryOptions) {
    this.conversationId = options.conversationId
    this.modelId = options.modelId
    this.memoryScope = options.memoryScope
    this.extract = options.extract ?? extractMemoriesFromPair
  }

  /** A sentence of the user that speech recognition has settled on. */
  userSaid(text: string): void {
    const said = text.trim()
    if (!said || this.finished) return
    this.closeAnswer()
    const store = useChatStore.getState()
    const messages = store.conversations.find((c) => c.id === this.conversationId)?.messages ?? []
    const last = messages[messages.length - 1]
    // A pause in the middle of a sentence arrives as two transcripts. They
    // are one turn as long as nothing was answered in between.
    if (last && last.role === 'user') {
      store.updateMessageContent(this.conversationId, last.id, `${last.content} ${said}`)
    } else {
      store.addMessage(this.conversationId, { id: uuid(), role: 'user', content: said, timestamp: Date.now() })
    }
    this.userWords.push(said)
    this.wrote = true
    if (this.callHome.size === 0) this.screenTalk = false
  }

  /** Text of the answer as the model produces it. */
  botText(delta: string): void {
    if (!delta || this.finished) return
    const answer = this.openAnswer()
    answer.content += delta
    answer.dirty = true
    this.schedule()
  }

  /** What the model thinks before it answers. Shown with the answer, never spoken. */
  botThought(delta: string): void {
    if (!delta || this.finished) return
    const answer = this.openAnswer()
    answer.thinking += delta
    answer.dirty = true
    this.schedule()
  }

  /** The answer is over: it was spoken to the end or the user spoke over it. */
  botTurnEnded(): void {
    this.flush()
  }

  toolEvent(event: VoiceToolEvent): void {
    if (this.finished) return
    const home = this.callHome.get(event.id) ?? this.openAnswer()
    this.callHome.set(event.id, home)
    if (SCREEN_TOOLS.has(event.name)) {
      home.sawScreen = true
      // The result of a long task arrives turns later, and the answer that
      // reports it is a new one. Everything said until the user speaks next
      // may describe the screen.
      this.screenTalk = true
    }
    const existing = home.blocks.find((block) => block.id === event.id)
    const previous = existing?.toolCalls?.[0]
    const now = Date.now()
    let call: AgentToolCall
    let label: string
    if (event.type === 'approval') {
      call = { id: event.id, toolName: event.name, args: event.args, status: 'pending_approval', timestamp: previous?.timestamp ?? now }
      label = `Requesting approval: ${event.name}`
    } else if (event.type === 'started') {
      call = { id: event.id, toolName: event.name, args: event.args, status: 'running', timestamp: previous?.timestamp ?? now, startedAt: now }
      label = `Running: ${event.name}`
    } else {
      call = {
        id: event.id,
        toolName: event.name,
        args: event.args,
        status: event.status,
        timestamp: previous?.timestamp ?? now,
        startedAt: previous?.startedAt,
        completedAt: now,
        duration: event.durationMs || undefined,
        ...(event.status === 'completed' ? { result: event.result ?? '' } : { error: event.result ?? 'The tool did not complete.' }),
      }
      label = `${event.status === 'completed' ? 'Completed' : event.status === 'rejected' ? 'Rejected' : 'Failed'}: ${event.name}`
      this.callHome.delete(event.id)
    }
    const block: AgentBlock = { id: event.id, phase: 'tool_call', content: label, toolCall: call, toolCalls: [call], timestamp: existing?.timestamp ?? now }
    home.blocks = existing ? home.blocks.map((b) => (b.id === event.id ? block : b)) : [...home.blocks, block]
    home.dirty = true
    this.write(home)
  }

  /**
   * The session ended. Writes what is still pending, removes a conversation
   * in which nothing happened, and hands the session to the memory
   * extraction once.
   */
  finish(): void {
    if (this.finished) return
    this.closeAnswer()
    this.finished = true
    const store = useChatStore.getState()
    if (!this.wrote) {
      store.deleteConversation(this.conversationId)
      return
    }
    const user = this.userWords.join('\n').slice(-DIGEST_CHARS)
    // Answers that reported on the screen were left out as they were closed.
    // When nothing else was answered, the user's words still count: what was
    // said aloud is what a voice session may remember.
    const assistant = this.answerWords.join('\n').slice(-DIGEST_CHARS) || (this.sawScreen ? SCREEN_RUN_STAND_IN : '')
    if (user && assistant) {
      void this.extract(user, assistant, this.conversationId, {
        scope: this.memoryScope, sourceKind: 'voice', digest: true,
      }).catch(() => {})
    }
  }

  private openAnswer(): OpenAnswer {
    if (this.answer) return this.answer
    const message: Message = {
      id: uuid(), role: 'assistant', content: '', modelId: this.modelId, timestamp: Date.now(), agentBlocks: [],
    }
    useChatStore.getState().addMessage(this.conversationId, message)
    this.wrote = true
    this.answer = { messageId: message.id, content: '', thinking: '', blocks: [], dirty: false, sawScreen: this.screenTalk }
    if (this.screenTalk) this.sawScreen = true
    return this.answer
  }

  private closeAnswer(): void {
    this.flush()
    const answer = this.answer
    if (!answer) return
    if (answer.sawScreen) this.sawScreen = true
    // What an answer says about the screen is not handed to the memory
    // extraction (lib/computer/memory-policy.ts).
    else if (answer.content.trim()) this.answerWords.push(answer.content.trim())
    this.answer = null
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.answer?.dirty) this.write(this.answer)
  }

  private write(answer: OpenAnswer): void {
    const store = useChatStore.getState()
    store.updateMessageContent(this.conversationId, answer.messageId, answer.content)
    if (answer.thinking) store.updateMessageThinking(this.conversationId, answer.messageId, answer.thinking)
    store.updateMessageAgentBlocks(this.conversationId, answer.messageId, answer.blocks)
    answer.dirty = false
  }
}
