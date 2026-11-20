/**
 * The first use of computer control in a chat waits for the user's yes.
 * Always: no setting, no app that is always allowed, no autonomous session
 * and no yes in another chat stands in for it.
 *
 * The fake below keeps the yes the way the Rust engine does: only an open
 * question can be answered, and no session begins without the yes.
 *
 * Run: npx vitest run src/api/__tests__/computer-chat-permission.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Call = { cmd: string; args: Record<string, unknown> }
type Session = { id: string; chatId: string; autonomous: boolean; allowed: { key: string; scope: string }[]; stopped: string | null; frameId: number | null }

const APP = { key: 'notepad.exe', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe', bundleId: null }
const rust = {
  calls: [] as Call[],
  asked: new Set<string>(),
  allowed: new Set<string>(),
  session: null as Session | null,
  sessions: 0,
  frames: 0,
  fired: [] as unknown[],
}
const refusal = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, refusal: { code, message, ...extra } })
const front = () => ({ id: 4242, pid: 1, app: APP, title: 'Untitled', className: null, rect: { x: 0, y: 0, width: 10, height: 10 }, minimized: false, elevated: false, isSelf: false, verdict: 'allowed', blockReason: null, foreground: true })

async function fakeBackend(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  rust.calls.push({ cmd, args })
  const s = rust.session
  switch (cmd) {
    case 'computer_chat_ask': {
      const chat = String(args.chatId)
      if (rust.allowed.has(chat)) return { ok: true, allowed: true }
      rust.asked.add(chat)
      return { ok: true, allowed: false }
    }
    case 'computer_chat_answer': {
      const chat = String(args.chatId)
      if (!rust.asked.delete(chat)) return refusal('invalid', 'There is no open question about computer control in this chat.')
      if (args.allow === true) rust.allowed.add(chat)
      return { ok: true, allowed: args.allow === true }
    }
    case 'computer_session_begin': {
      const options = args.options as { chatId?: string; autonomous?: boolean }
      if (!options.chatId || !rust.allowed.has(options.chatId)) return refusal('needs_chat_permission', 'The user has not allowed computer control in this chat.')
      rust.sessions += 1
      rust.session = { id: `s${rust.sessions}`, chatId: options.chatId, autonomous: options.autonomous === true, allowed: [], stopped: null, frameId: null }
      return { ok: true, session: rust.session, stopShortcut: 'Ctrl+Alt+Esc' }
    }
    case 'computer_session_allow_app':
      if (!s || args.sessionId !== s.id) return refusal('no_session', 'There is no computer control session. Start one first.')
      s.allowed = [...s.allowed, { key: String(args.appKey), scope: String(args.scope) }]
      return { ok: true, session: { ...s } }
    case 'computer_session_end':
      rust.session = null
      return { ok: true, ended: true }
    case 'computer_windows':
      if (!s) return refusal('no_session', 'There is no computer control session. Start one first.')
      return { ok: true, foreground: front(), windows: [front()] }
    case 'computer_screen':
      if (!s || args.sessionId !== s.id) return refusal('no_session', 'There is no computer control session. Start one first.')
      rust.frames += 1
      s.frameId = rust.frames
      return { ok: true, frameId: rust.frames, monitor: { id: 1, name: 'D', rect: { x: 0, y: 0, width: 1920, height: 1080 }, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1, primary: true }, width: 1568, height: 882, scale: 0.8, cursor: [10, 20], foreground: front(), hiddenAreas: 0, mime: null, image: null }
    case 'computer_action': {
      if (!s || args.sessionId !== s.id) return refusal('no_session', 'There is no computer control session. Start one first.')
      const request = args.request as { action: { type: string }; confirmed: boolean }
      if (!s.allowed.some((g) => g.key === APP.key)) return refusal('needs_approval', 'The user has not allowed LU to control Notepad in this session.', { app: APP })
      if (!request.confirmed && !s.autonomous) return refusal('needs_confirmation', 'This session is supervised. The user confirms each action.', { app: APP })
      rust.fired.push(request)
      return { ok: true, performed: `Did ${request.action.type} in Notepad.`, app: APP, windowTitle: 'Untitled' }
    }
    case 'computer_status':
      return { ok: true, treeAvailable: false }
    default:
      return { ok: true }
  }
}

// The wait for the note is real time in the app (computer-note.test.tsx holds it). Here it would only be waited out.
vi.mock('../../lib/computer/start-note', async (original) => ({ ...(await original<typeof import('../../lib/computer/start-note')>()), holdForStartNote: async () => {} }))

vi.mock('../backend', () => ({
  backendCall: (cmd: string, args?: Record<string, unknown>) => fakeBackend(cmd, args),
  isTauri: () => true,
}))

import { executeComputerUse, noteUserAskedAgain, resetComputerUseForTests } from '../computer-use'
import { runComputerTask } from '../computer-task'
import { CHAT_PERMISSION_DENIED, answerComputerChatAsk, computerChatKey } from '../computer-chat'
import { answerComputerPrompt, refusePendingComputerPrompt, type AppAnswer } from '../../lib/computer/prompts'
import { resetComputerPauseForTests } from '../../lib/computer/pause'
import { useComputerStore } from '../../stores/computerStore'
import { voiceAnswered } from '../voice-computer'
import type { AgentRunContext } from '../agent-context'

const run = (token: string, conversationId: string | null, standing = false) => ({ token, conversationId, standing }) as AgentRunContext
const commands = () => rust.calls.map((c) => c.cmd)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Wait until the question of a chat is on screen. */
async function question() {
  for (let i = 0; i < 50 && !useComputerStore.getState().chatAsk; i++) await tick()
  const ask = useComputerStore.getState().chatAsk
  if (!ask) throw new Error('no question about this chat came up')
  return ask
}
/** Answer the questions per app and per action as scripted, as the user would. */
function answerApps(answers: (AppAnswer | boolean)[]) {
  return useComputerStore.subscribe((state, before) => {
    if (state.prompt && state.prompt !== before.prompt) {
      const answer = answers.shift()
      if (answer === undefined) throw new Error(`unexpected question: ${JSON.stringify(state.prompt)}`)
      const id = state.prompt.id
      queueMicrotask(() => answerComputerPrompt(id, answer))
    }
  })
}

beforeEach(() => {
  Object.assign(rust, { calls: [], asked: new Set(), allowed: new Set(), session: null, sessions: 0, frames: 0, fired: [] })
  refusePendingComputerPrompt()
  resetComputerPauseForTests()
  resetComputerUseForTests()
  useComputerStore.setState({ enabled: true, alwaysAllowed: [], session: null, stopShortcut: null, autonomous: false, stopped: null, prompt: null, chatAsk: null, notice: null, currentApp: null, task: null, working: false, surface: 'window', corner: 'top_right', paused: false, pauseWhy: null })
})

describe('the first use in a chat asks, whatever is set', () => {
  it('a look waits for the yes: no session, no picture and nothing that shows work before it', async () => {
    const call = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    const ask = await question()
    expect(ask).toMatchObject({ chatKey: 'chat-a', conversationId: 'chat-a', voice: false })
    // Rust was asked about the chat and nothing else. LU does not look busy: the window stays the window.
    expect(commands()).toEqual(['computer_chat_ask'])
    expect(useComputerStore.getState().working).toBe(false)
    expect(useComputerStore.getState().session).toBeNull()
    answerComputerChatAsk(ask.id, true)
    expect(await call).toMatch(/^Screenshot \[screen frame/)
    expect(commands().slice(0, 4)).toEqual(['computer_chat_ask', 'computer_chat_answer', 'computer_session_begin', 'computer_screen'])
    expect(rust.calls[2].args).toEqual({ options: { chatId: 'chat-a', autonomous: false } })
    expect(useComputerStore.getState().chatAsk).toBeNull()
  })

  it('the second use in the same chat does not ask again, in a later run either', async () => {
    const first = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    answerComputerChatAsk((await question()).id, true)
    await first
    rust.calls = []
    await executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    await executeComputerUse({ action: 'screenshot' }, run('r2', 'chat-a'))
    expect(commands()).toEqual(['computer_screen', 'computer_windows', 'computer_screen', 'computer_windows'])
    expect(useComputerStore.getState().chatAsk).toBeNull()
  })

  it('a new chat asks again, and what was approved in the first chat does not come along', async () => {
    const stop = answerApps(['session', true])
    const first = executeComputerUse({ action: 'type', text: 'a' }, run('r1', 'chat-a'))
    answerComputerChatAsk((await question()).id, true)
    expect(await first).toMatch(/^Did type in Notepad/)
    stop()
    expect(rust.session).toMatchObject({ chatId: 'chat-a', allowed: [{ key: 'notepad.exe', scope: 'session' }] })

    const second = executeComputerUse({ action: 'type', text: 'b' }, run('r2', 'chat-b'))
    const ask = await question()
    expect(ask.chatKey).toBe('chat-b')
    // The session of the first chat is over the moment the second one asks.
    expect(rust.session).toBeNull()
    expect(rust.fired).toHaveLength(1)
    const again = answerApps(['session', true])
    answerComputerChatAsk(ask.id, true)
    expect(await second).toMatch(/^Did type in Notepad/)
    again()
    expect(rust.session).toMatchObject({ id: 's2', chatId: 'chat-b' })
  })

  it('an autonomous session and an app that is always allowed do not skip the question', async () => {
    useComputerStore.setState({ autonomous: true, alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }] })
    const call = executeComputerUse({ action: 'type', text: 'hello' }, run('r1', 'chat-a'))
    const ask = await question()
    expect(rust.fired).toHaveLength(0)
    expect(commands()).toEqual(['computer_chat_ask'])
    answerComputerChatAsk(ask.id, true)
    await call
    expect(rust.fired).toHaveLength(1)
  })

  it('a screen task asks before it shows anywhere, and a no ends it without a look', async () => {
    const task = runComputerTask({ goal: 'Type hello into Notepad.' }, run('r1', 'chat-a'))
    const ask = await question()
    expect(useComputerStore.getState().task).toBeNull()
    expect(useComputerStore.getState().working).toBe(false)
    answerComputerChatAsk(ask.id, false)
    expect(await task).toBe(CHAT_PERMISSION_DENIED)
    expect(commands()).toEqual(['computer_chat_ask', 'computer_chat_answer'])
    expect(rust.calls[1].args).toEqual({ chatId: 'chat-a', allow: false })
  })
})

describe('a no', () => {
  it('runs nothing, says so to the model, and the same run is not asked again', async () => {
    const call = executeComputerUse({ action: 'type', text: 'hello' }, run('r1', 'chat-a'))
    answerComputerChatAsk((await question()).id, false)
    const result = await call
    expect(result).toContain('The user did not allow computer control in this chat.')
    expect(rust.fired).toHaveLength(0)
    expect(rust.session).toBeNull()
    rust.calls = []
    // The model tries again in the same turn: the same answer, no question, nothing sent to Rust.
    expect(await executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))).toBe(CHAT_PERMISSION_DENIED)
    expect(await runComputerTask({ goal: 'Type hello into Notepad.' }, run('r1', 'chat-a'))).toBe(CHAT_PERMISSION_DENIED)
    expect(useComputerStore.getState().chatAsk).toBeNull()
    expect(rust.calls).toEqual([])
  })

  it('the next message of the user asks again', async () => {
    const call = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    answerComputerChatAsk((await question()).id, false)
    await call
    const next = executeComputerUse({ action: 'screenshot' }, run('r2', 'chat-a'))
    answerComputerChatAsk((await question()).id, true)
    expect(await next).toMatch(/^Screenshot \[screen frame/)
  })

  it('a run that is stopped while the question is open got no answer: nothing is allowed and the next run asks', async () => {
    const stop = new AbortController()
    const call = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'), stop.signal)
    await question()
    stop.abort()
    expect(await call).toBe(CHAT_PERMISSION_DENIED)
    expect(rust.allowed.size).toBe(0)
    expect(useComputerStore.getState().chatAsk).toBeNull()
    const next = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    expect((await question()).chatKey).toBe('chat-a')
    answerComputerChatAsk(useComputerStore.getState().chatAsk!.id, false)
    await next
  })
})

describe('who can answer', () => {
  it('two calls of one chat wait for one question', async () => {
    const one = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    const two = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    const ask = await question()
    expect(commands().filter((c) => c === 'computer_chat_ask')).toHaveLength(1)
    answerComputerChatAsk(ask.id, true)
    expect(await one).toMatch(/^Screenshot \[screen frame/)
    expect(await two).toMatch(/^Screenshot \[screen frame/)
  })

  it('an answer for a question that is gone does nothing', async () => {
    const call = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    const ask = await question()
    answerComputerChatAsk('computer-chat-ask-0', true)
    await tick()
    expect(useComputerStore.getState().chatAsk).toEqual(ask)
    expect(rust.allowed.size).toBe(0)
    answerComputerChatAsk(ask.id, false)
    await call
  })

  it('a voice session is asked on its own surface, and a spoken yes does not answer', async () => {
    const voice = run('v1', 'voice-1', true)
    const call = executeComputerUse({ action: 'screenshot' }, voice)
    const ask = await question()
    expect(ask).toMatchObject({ chatKey: 'voice-1', voice: true })
    // LU comes to the front: the user may be looking at another app.
    expect(commands()).toContain('computer_request_attention')
    voiceAnswered(ask.id, 'yes')
    await tick()
    expect(useComputerStore.getState().chatAsk).toEqual(ask)
    expect(rust.allowed.size).toBe(0)
    // A no holds for the request it answered. The next thing the user says asks again.
    answerComputerChatAsk(ask.id, false)
    expect(await call).toBe(CHAT_PERMISSION_DENIED)
    expect(await executeComputerUse({ action: 'screenshot' }, voice)).toBe(CHAT_PERMISSION_DENIED)
    noteUserAskedAgain(voice)
    const again = executeComputerUse({ action: 'screenshot' }, voice)
    answerComputerChatAsk((await question()).id, true)
    expect(await again).toMatch(/^Screenshot \[screen frame/)
  })

  it('a run without a conversation is a chat of its own, and a call without a run still asks', () => {
    expect(computerChatKey(run('r9', null))).toBe('r9')
    expect(computerChatKey(undefined)).toBe('direct')
    expect(computerChatKey(run('r9', 'chat-a'))).toBe('chat-a')
  })

  it('Rust has the last word: a chat this window took for allowed gets no session and is asked again', async () => {
    const first = executeComputerUse({ action: 'screenshot' }, run('r1', 'chat-a'))
    answerComputerChatAsk((await question()).id, true)
    await first
    // The app restarted under the window, or the session ended: Rust knows nothing of a yes any more.
    rust.allowed.clear()
    rust.session = null
    useComputerStore.setState({ session: null })
    expect(await executeComputerUse({ action: 'screenshot' }, run('r2', 'chat-a'))).toBe(CHAT_PERMISSION_DENIED)
    const next = executeComputerUse({ action: 'screenshot' }, run('r3', 'chat-a'))
    expect((await question()).chatKey).toBe('chat-a')
    answerComputerChatAsk(useComputerStore.getState().chatAsk!.id, true)
    expect(await next).toMatch(/^Screenshot \[screen frame/)
  })
})
