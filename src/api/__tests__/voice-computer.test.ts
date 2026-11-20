// @vitest-environment jsdom
/**
 * Where a voice session and computer control meet (voice-computer.ts).
 *
 * The two were built side by side: the surface of Voice (Agent switch, "Where
 * it may work", thoughts, the light switch) and the surface of computer
 * control (the pill, the question above the input field, pausing instead of
 * stopping). These tests hold what neither could test alone:
 *
 *   - "Workspace only" and Agent off mean no screen: no session of computer
 *     control begins, so there is no pill, no glow and no question.
 *   - "Whole computer" runs a screen call, and its question is asked aloud.
 *   - A spoken "stop" or "wait" lands in the very state the pause shortcut
 *     leads to, and the voice does not answer a question while paused.
 *   - The end of the voice session (Stop, the light switch) ends a running
 *     or paused screen call and gives the window back.
 *
 * Rust is a stand-in here, as in computer-pause.test.ts.
 *
 * Run: npx vitest run src/api/__tests__/voice-computer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import { PipecatClient, RTVIMessage, RTVIMessageType } from '@pipecat-ai/client-js'
import { VoiceTestTransport } from './helpers/voice-transport'

type Call = { cmd: string; args: Record<string, unknown> }

const APP = { key: 'notepad.exe', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe', bundleId: null }
const PAUSED = 'The user moved the mouse or pressed a key, so computer control is paused. Nothing runs until the user decides whether to take over or to let LU continue.'

const rust = {
  calls: [] as Call[],
  session: null as null | { id: string; chatId: string; autonomous: boolean; allowed: { key: string; scope: string }[]; stopped: string | null },
  paused: false,
  frames: 0,
  fired: [] as unknown[],
  /** What the engine asks the user to confirm: nothing, every action, or a click on "Send" on top. */
  confirms: 'none' as 'none' | 'every' | 'send',
  /** The user said yes to computer control in every chat already. False: the first use asks. */
  chatAllowed: true,
  chatAnswers: [] as boolean[],
}

const SEND_REASON = 'The click target "Send" contains "send", which usually sends something. It needs your confirmation.'

const refusal = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, refusal: { code, message, ...extra } })
const front = () => ({ id: 4242, pid: 1, app: APP, title: 'Untitled', className: null, rect: { x: 0, y: 0, width: 10, height: 10 }, minimized: false, elevated: false, isSelf: false, verdict: rust.session?.allowed.length ? 'allowed' : 'needs_approval', blockReason: null, foreground: true })

async function fakeBackend(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  rust.calls.push({ cmd, args })
  const s = rust.session
  const stopped = () => refusal('stopped', 'The user stopped computer control. Do not continue. Tell the user what was done so far.')
  switch (cmd) {
    // The user said yes in every chat, except where a test asks. The question itself: computer-chat-permission.test.ts.
    case 'computer_chat_ask':
      return { ok: true, allowed: rust.chatAllowed }
    case 'computer_chat_answer':
      rust.chatAnswers.push(args.allow === true)
      return { ok: true, allowed: args.allow === true }
    case 'computer_session_begin':
      if (rust.paused) return refusal('paused', PAUSED)
      rust.session = { id: 's1', chatId: String((args.options as { chatId?: string })?.chatId), autonomous: (args.options as { autonomous?: boolean })?.autonomous === true, allowed: [], stopped: null }
      return { ok: true, session: rust.session, stopShortcut: 'Ctrl+Alt+Esc', pauseShortcut: 'Ctrl+Alt+Space' }
    case 'computer_session_allow_app':
      if (s) s.allowed.push({ key: String(args.appKey), scope: String(args.scope) })
      return { ok: true, session: s ? { ...s } : null }
    case 'computer_session_end':
      rust.session = null
      return { ok: true, ended: true }
    case 'computer_stop':
      if (s) s.stopped = 'user'
      rust.paused = false
      return { ok: true, session: s }
    case 'computer_pause':
      // The engine: nothing to pause without a session or after a stop.
      if (s && !s.stopped) rust.paused = true
      return { ok: true, paused: rust.paused }
    case 'computer_takeover_answer':
      rust.paused = false
      if (!args.continue && s) s.stopped = 'takeover'
      return { ok: true, paused: false, session: s }
    case 'computer_watch':
      return { ok: true, paused: rust.paused }
    case 'computer_windows':
      return { ok: true, foreground: front(), windows: [front()] }
    case 'computer_screen':
      if (!s) return refusal('no_session', 'There is no computer control session. Start one first.')
      if (s.stopped) return stopped()
      if (rust.paused) return refusal('paused', PAUSED)
      rust.frames += 1
      return {
        ok: true, frameId: rust.frames, monitor: { id: 3, name: 'D', rect: { x: 0, y: 0, width: 1920, height: 1080 }, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1, primary: true },
        width: 1568, height: 882, scale: 0.8, cursor: [10, 20], foreground: front(), hiddenAreas: 0, mime: 'image/jpeg', image: 'QUJD',
      }
    case 'computer_action':
      if (!s) return refusal('no_session', 'There is no computer control session. Start one first.')
      if (s.stopped) return stopped()
      if (rust.paused) return refusal('paused', PAUSED)
      if (!s.allowed.some((g) => g.key === APP.key)) return refusal('needs_approval', 'The user has not allowed LU to control Notepad in this session.', { app: APP })
      if (rust.confirms !== 'none' && !(args.request as { confirmed?: boolean }).confirmed) {
        // The engine: the reason first, in a supervised session as in an autonomous one.
        if (rust.confirms === 'send' && (args.request as { action: { type: string } }).action.type === 'click') return refusal('needs_confirmation', SEND_REASON, { app: APP, sensitive: true })
        if (!s.autonomous) return refusal('needs_confirmation', 'This session is supervised. The user confirms each action.', { app: APP })
      }
      rust.fired.push(args.request)
      return { ok: true, performed: 'Did it in Notepad.', app: APP, windowTitle: 'Untitled' }
    default:
      return { ok: true }
  }
}

vi.mock('../backend', () => ({
  backendCall: (cmd: string, args?: Record<string, unknown>) => fakeBackend(cmd, args),
  isTauri: () => true,
}))

import { computerControlBusy, executeComputerStep, executeComputerUse, pauseComputerControl, resetComputerUseForTests, COMPUTER_USE_TOOL } from '../computer-use'
import { announceComputerControl, endScreenWorkOutOfScope, voiceAnswered, voiceSaidStop, CHAT_QUESTION } from '../voice-computer'
import { answerComputerChatAsk, CHAT_PERMISSION_DENIED } from '../computer-chat'
import { VoiceToolBridge } from '../voice-tool-bridge'
import { ToolRegistry } from '../mcp/tool-registry'
import { DEFAULT_PERMISSIONS } from '../mcp/types'
import type { PermissionLevel } from '../mcp/types'
import { createVoiceLoopStore } from '../../stores/voiceLoopStore'
import { answerComputerPause, noteComputerPaused, resetComputerPauseForTests } from '../../lib/computer/pause'
import { answerComputerPrompt, refusePendingComputerPrompt } from '../../lib/computer/prompts'
import { wantedSurface } from '../../lib/computer/surface'
import { AGENT_OFF_REFUSAL, SCREEN_REFUSAL, levelInScope, scopeRefusal, toolInScope } from '../../lib/voice/work-scope'
import type { VoiceWork } from '../../lib/voice/work-scope'
import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME } from '../../lib/computer/prompt'
import { useComputerStore } from '../../stores/computerStore'
import type { AgentRunContext } from '../agent-context'

/** A voice session is one standing run from Start to Stop. */
const voiceRun = (token = 'voice-1', abortSignal?: AbortSignal) => ({ token, standing: true, abortSignal }) as AgentRunContext
const chatRun = (token = 'chat-1') => ({ token }) as AgentRunContext
const sent = (cmd: string) => rust.calls.filter((c) => c.cmd === cmd).length
const state = () => useComputerStore.getState()
/** The shape of LU's window, from the same facts the host reads. */
const surface = () => {
  const s = state()
  return wantedSurface({ busy: computerControlBusy(), stopped: !!s.stopped, asking: !!s.prompt, paused: s.paused })
}

beforeEach(() => {
  Object.assign(rust, { calls: [], session: null, paused: false, frames: 0, fired: [], confirms: 'none', chatAllowed: true, chatAnswers: [] })
  refusePendingComputerPrompt()
  resetComputerUseForTests()
  resetComputerPauseForTests()
  useComputerStore.setState({
    enabled: true, alwaysAllowed: [], session: null, stopShortcut: null, pauseShortcut: null,
    autonomous: false, stopped: null, prompt: null, notice: null, currentApp: null, task: null, working: false, paused: false, pauseAsked: false, monitorId: null,
  })
})

afterEach(() => {
  refusePendingComputerPrompt()
})

// ── The switches of Voice decide whether there is a screen at all ───────────

const bridges: VoiceToolBridge[] = []
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.stop() })

/** The tool bridge of a voice session, wired to the switches the way voice-session.ts wires it. */
function session(work: () => VoiceWork, toolTimeoutMs?: number) {
  const transport = new VoiceTestTransport()
  const client = new PipecatClient({ transport, enableMic: false, enableCam: false })
  const registry = new ToolRegistry()
  registry.registerBuiltin(COMPUTER_USE_TOOL, executeComputerUse)
  const parent = new AbortController()
  const run: AgentRunContext = { token: 'voice-1', chatId: 'voice', conversationId: 'voice', workspace: null, standing: true,
    artifactMode: false, readOnlyShellTurn: false, mode: null, artifacts: [], abortSignal: parent.signal }
  const permissions = { categories: { ...DEFAULT_PERMISSIONS, desktop: 'auto' as PermissionLevel }, overrides: {} as Record<string, PermissionLevel> }
  const bridge = new VoiceToolBridge({
    client, registry, run, store: createVoiceLoopStore('local', 'assistant'), offeredTools: [COMPUTER_USE_TOOL_NAME], permissions: () => permissions,
    toolTimeoutMs,
    refuse: (name, args) => scopeRefusal({ name, args }, work(), null),
    narrow: (name, level) => levelInScope(name, level, work()),
  })
  bridges.push(bridge)
  const call = (id: string, args: Record<string, unknown>) =>
    transport.receive(new RTVIMessage(RTVIMessageType.LLM_FUNCTION_CALL_IN_PROGRESS, { tool_call_id: id, function_name: COMPUTER_USE_TOOL_NAME, arguments: args }))
  const results = () => transport.sent.map((m) => (m.data as { result: { status: string; text?: string; error?: string } }).result)
  return { bridge, call, results, parent }
}

describe('where a voice session may work decides whether there is a screen', () => {
  it.each([
    ['"Workspace only"', { agent: true, scope: 'workspace' } as VoiceWork, SCREEN_REFUSAL],
    ['Agent off', { agent: false, scope: 'computer' } as VoiceWork, AGENT_OFF_REFUSAL],
  ])('%s: a screen call is refused before computer control hears of it, so nothing of it shows', async (_name, work, sentence) => {
    // The model is not even shown the tools of the screen.
    expect(toolInScope(COMPUTER_TASK_TOOL_NAME, work)).toBe(false)
    expect(toolInScope(COMPUTER_USE_TOOL_NAME, work)).toBe(false)
    // A model that calls one anyway is told why not.
    const s = session(() => work)
    s.call('c-1', { action: 'screenshot' })
    await waitFor(() => expect(s.results()).toHaveLength(1))
    expect(s.results()[0]).toMatchObject({ status: 'failed', error: sentence })
    s.call('c-2', { action: 'click', x: 500, y: 500 })
    await waitFor(() => expect(s.results()).toHaveLength(2))
    expect(s.results()[1]).toMatchObject({ status: 'failed', error: sentence })
    // Rust was never asked: no session, so no shortcut, no pill, no glow.
    expect(rust.calls).toEqual([])
    expect(state()).toMatchObject({ session: null, prompt: null, task: null, working: false, paused: false })
    expect(computerControlBusy()).toBe(false)
    expect(surface()).toEqual({ mode: 'window', active: false, focus: false })
  })

  it('"Whole computer": the call runs, the question for the app opens, LU is busy and the question is asked aloud', async () => {
    const said: { kind: string; data: Record<string, unknown> }[] = []
    const off = announceComputerControl((kind, data) => said.push({ kind, data }), () => undefined)
    const s = session(() => ({ agent: true, scope: 'computer' }))
    s.call('c-1', { action: 'screenshot' })
    await waitFor(() => expect(s.results()).toHaveLength(1))
    expect(s.results()[0].status).toBe('completed')
    expect(sent('computer_session_begin')).toBe(1)
    // A click in an app the user has not approved yet: the question.
    s.call('c-2', { action: 'click', x: 500, y: 500 })
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'app' }))
    expect(surface()).toEqual({ mode: 'panel', active: true, focus: false })
    expect(said).toEqual([{ kind: 'question', data: { id: state().prompt!.id, text: 'May I work in Notepad? Say yes or no.', voice: true } }])
    // A spoken yes: for this session, never "always".
    voiceAnswered(state().prompt!.id, 'yes')
    await waitFor(() => expect(rust.session?.allowed).toHaveLength(1))
    expect(rust.session?.allowed).toEqual([{ key: 'notepad.exe', scope: 'session' }])
    expect(state().alwaysAllowed).toEqual([])
    // The call goes on with the answer, and the voice loop is told the question is closed.
    await waitFor(() => expect(s.results()).toHaveLength(2), { timeout: 3000 })
    expect(rust.fired).toHaveLength(1)
    expect(said.map((m) => m.kind)).toEqual(['question', 'question-closed'])
    off()
  })

  it('the switch moved to "Workspace only" or Agent off while a screen call of the session waits: the call ends like Stop', async () => {
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, voiceRun())
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'app' }))
    // Still allowed: nothing happens.
    expect(await endScreenWorkOutOfScope({ agent: true, scope: 'computer' })).toBe(false)
    expect(state().prompt).not.toBeNull()
    expect(await endScreenWorkOutOfScope({ agent: true, scope: 'workspace' })).toBe(true)
    const step = await pending
    expect(step.end).toBe('stopped')
    expect(sent('computer_stop')).toBe(1)
    expect(state().prompt).toBeNull()
    expect(rust.fired).toEqual([])
    expect(surface()).toEqual({ mode: 'window', active: false, focus: false })
    // Nothing left to end.
    expect(await endScreenWorkOutOfScope({ agent: false, scope: 'computer' })).toBe(false)
    expect(sent('computer_stop')).toBe(1)
  })

  it('the switches of Voice never end the screen work of a chat', async () => {
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, chatRun())
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'app' }))
    expect(await endScreenWorkOutOfScope({ agent: false, scope: 'workspace' })).toBe(false)
    expect(sent('computer_stop')).toBe(0)
    expect(state().prompt).not.toBeNull()
    refusePendingComputerPrompt()
    await pending
  })
})

// ── What a spoken yes may confirm ───────────────────────────────────────────

describe('a supervised voice session: what a spoken yes confirms', () => {
  const supervised = async () => {
    useComputerStore.setState({ alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], autonomous: false })
    const said: { kind: string; data: Record<string, unknown> }[] = []
    const off = announceComputerControl((kind, data) => said.push({ kind, data }), () => undefined)
    await executeComputerUse({ action: 'screenshot' }, voiceRun())
    expect(rust.session).toMatchObject({ autonomous: false })
    return { said, off }
  }

  it('an ordinary action is asked aloud and a spoken yes runs it', async () => {
    rust.confirms = 'every'
    const { said, off } = await supervised()
    const pending = executeComputerStep({ action: 'type', text: 'hello' }, voiceRun())
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'confirm', sensitive: false, reason: null }))
    expect(said.at(-1)).toEqual({ kind: 'question', data: { id: state().prompt!.id, text: 'I want to type some text in Notepad. Yes or no?', voice: true } })
    voiceAnswered(state().prompt!.id, 'yes')
    const step = await pending
    expect(step.end).toBeNull()
    expect(rust.fired).toHaveLength(1)
    expect(rust.fired[0]).toMatchObject({ confirmed: true })
    off()
  })

  it('the click on "Send" carries its reason, takes no spoken yes, and runs on the click alone', async () => {
    // Windows run A22, 11.3: asked like any click, and "Yes" pressed Send.
    rust.confirms = 'send'
    const { said, off } = await supervised()
    const pending = executeComputerStep({ action: 'click', x: 296, y: 253 }, voiceRun())
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'confirm', sensitive: true, reason: SEND_REASON }))
    const id = state().prompt!.id
    // Asked aloud as a question the voice cannot answer.
    expect(said.at(-1)).toEqual({ kind: 'question', data: { id, text: 'I want to click in Notepad. This one needs your click on the screen.', voice: false } })
    voiceAnswered(id, 'yes')
    voiceAnswered(id, 'yes')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state().prompt?.id).toBe(id)
    expect(rust.fired).toEqual([])
    // The user's click on Confirm.
    answerComputerPrompt(id, true)
    const step = await pending
    expect(step.end).toBeNull()
    expect(rust.fired).toHaveLength(1)
    expect(rust.fired[0]).toMatchObject({ action: { type: 'click' }, confirmed: true })
    off()
  })

  it('a spoken no declines the click on "Send"', async () => {
    rust.confirms = 'send'
    const { off } = await supervised()
    const pending = executeComputerStep({ action: 'click', x: 296, y: 253 }, voiceRun())
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'confirm', sensitive: true }))
    voiceAnswered(state().prompt!.id, 'no')
    const step = await pending
    expect(step.end).toBe('declined')
    expect(rust.fired).toEqual([])
    off()
  })
})

// ── Pause during a voice session ────────────────────────────────────────────

/** A voice session with Notepad approved, at work. */
async function atWork(run = voiceRun()) {
  useComputerStore.setState({ alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], autonomous: true })
  await executeComputerUse({ action: 'screenshot' }, run)
  expect(rust.session).not.toBeNull()
}

describe('a spoken "stop" or "wait" pauses, exactly as the pause shortcut does', () => {
  it('the word holds the session in Rust and the paused view comes up; nothing is stopped', async () => {
    await atWork()
    voiceSaidStop()
    await waitFor(() => expect(state().paused).toBe(true))
    expect(sent('computer_pause')).toBe(1)
    expect(sent('computer_stop')).toBe(0)
    expect(state().stopped).toBeNull()
    expect(state().pauseAsked).toBe(true)
    expect(surface()).toEqual({ mode: 'panel', active: true, focus: true })
    // The next action does not run. It waits for the user's click.
    let result: string | null = null
    void executeComputerUse({ action: 'click', x: 500, y: 500 }, voiceRun()).then((text) => { result = text })
    await new Promise((done) => setTimeout(done, 30))
    expect(result).toBeNull()
    expect(rust.fired).toEqual([])
    await answerComputerPause(true)
    await waitFor(() => expect(result).not.toBeNull())
    expect(result).toMatch(/LU paused and this step did not run\. The user let LU continue\./)
    expect(state()).toMatchObject({ paused: false, pauseAsked: false, stopped: null })
  })

  it('the shortcut and the word end in the same state', async () => {
    await atWork()
    // The shortcut: Rust pauses and tells the interface (computer://paused).
    rust.paused = true
    noteComputerPaused()
    const byShortcut = { paused: state().paused, stopped: state().stopped, surface: surface(), rustPaused: rust.paused, busy: computerControlBusy() }
    await answerComputerPause(true)
    expect(state().paused).toBe(false)

    voiceSaidStop()
    await waitFor(() => expect(state().paused).toBe(true))
    const byVoice = { paused: state().paused, stopped: state().stopped, surface: surface(), rustPaused: rust.paused, busy: computerControlBusy() }
    expect(byVoice).toEqual(byShortcut)
    // Both leave by the same two buttons.
    await answerComputerPause(false)
    expect(state().paused).toBe(false)
    expect(rust.session?.stopped).toBe('takeover')
  })

  it('said twice, or said while the user already has the mouse, it pauses once', async () => {
    await atWork()
    await pauseComputerControl()
    await pauseComputerControl()
    voiceSaidStop()
    expect(sent('computer_pause')).toBe(1)
    expect(state().paused).toBe(true)
    await answerComputerPause(false)
  })

  it('where there is nothing to pause, the word still ends what is going on: it stops', async () => {
    // No session yet (the task has not looked at the screen).
    await pauseComputerControl()
    expect(sent('computer_pause')).toBe(1)
    expect(sent('computer_stop')).toBe(1)
    expect(state()).toMatchObject({ paused: false, pauseAsked: false })
    expect(state().stopped?.reason).toBe('user')
  })

  it('while paused the voice answers no question, and the question is asked aloud again after "Let it continue"', async () => {
    useComputerStore.setState({ autonomous: false })
    const said: { kind: string; data: Record<string, unknown> }[] = []
    const off = announceComputerControl((kind, data) => said.push({ kind, data }), () => undefined)
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, voiceRun())
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'app' }))
    const id = state().prompt!.id
    expect(said.map((m) => m.kind)).toEqual(['question'])

    voiceSaidStop()
    await waitFor(() => expect(state().paused).toBe(true))
    // The voice loop is told that no question is open for it.
    expect(said.map((m) => m.kind)).toEqual(['question', 'question-closed'])
    // A "yes" the room said meanwhile answers nothing.
    voiceAnswered(id, 'yes')
    expect(state().prompt?.id).toBe(id)
    expect(rust.session?.allowed).toEqual([])

    await answerComputerPause(true)
    expect(state().paused).toBe(false)
    expect(said.map((m) => m.kind)).toEqual(['question', 'question-closed', 'question'])
    expect(said[2].data).toMatchObject({ id, voice: true })
    // Now the spoken no counts again.
    voiceAnswered(id, 'no')
    const step = await pending
    expect(step.end).toBe('denied')
    expect(rust.fired).toEqual([])
    off()
  })

  it('the voice loop hears when a task starts and ends', () => {
    const said: { kind: string; data: Record<string, unknown> }[] = []
    let started = 0
    const off = announceComputerControl((kind, data) => said.push({ kind, data }), () => { started += 1 })
    useComputerStore.getState().setTask({ goal: 'Save the note', maxSteps: 25, steps: [], phase: 'looking', modelLabel: 'Qwen' })
    useComputerStore.getState().setTask(null)
    expect(said).toEqual([{ kind: 'task', data: { active: true } }, { kind: 'task', data: { active: false } }])
    expect(started).toBe(1)
    off()
    useComputerStore.getState().setTask({ goal: 'again', maxSteps: 25, steps: [], phase: 'looking', modelLabel: 'Qwen' })
    expect(said).toHaveLength(2)
    useComputerStore.getState().setTask(null)
  })
})

// ── The voice session ends while the screen is in use ───────────────────────

describe('the end of the voice session (Stop, leaving Voice, the light switch) ends the screen work', () => {
  it('while an action waits behind a pause: the pause is over, Rust is stopped, the window comes back', async () => {
    const ending = new AbortController()
    await atWork(voiceRun('voice-1', ending.signal))
    voiceSaidStop()
    await waitFor(() => expect(state().paused).toBe(true))
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, voiceRun('voice-1', ending.signal), ending.signal)
    await new Promise((done) => setTimeout(done, 30))
    expect(surface().mode).toBe('panel')
    // What teardown() of the session does first.
    ending.abort()
    const step = await pending
    expect(step.end).toBe('stopped')
    await waitFor(() => expect(sent('computer_stop')).toBe(1))
    expect(state()).toMatchObject({ paused: false, pauseAsked: false, prompt: null })
    expect(rust.paused).toBe(false)
    expect(rust.fired).toEqual([])
    // Nobody answered the pause for the user.
    expect(sent('computer_takeover_answer')).toBe(0)
    expect(surface()).toEqual({ mode: 'window', active: false, focus: false })
  })

  it('while a question is open in the bridge of the session: stopping the bridge closes it and stops Rust', async () => {
    const s = session(() => ({ agent: true, scope: 'computer' }))
    s.call('c-1', { action: 'click', x: 500, y: 500 })
    await waitFor(() => expect(state().prompt).toMatchObject({ kind: 'app' }))
    expect(surface().active).toBe(true)
    // teardown(): the run is aborted and the bridge stopped.
    s.parent.abort()
    await waitFor(() => expect(state().prompt).toBeNull())
    await waitFor(() => expect(sent('computer_stop')).toBe(1))
    expect(rust.fired).toEqual([])
    expect(state().working).toBe(false)
    expect(surface()).toEqual({ mode: 'window', active: false, focus: false })
  })

  it('a pause has no timer of its own, but the time the session gives a call still runs: when it is up, the call ends as stopped', async () => {
    useComputerStore.setState({ alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], autonomous: true })
    // In the app a screen task gets nine minutes from the session. Here: 400 ms.
    const s = session(() => ({ agent: true, scope: 'computer' }), 400)
    s.call('c-1', { action: 'screenshot' })
    await waitFor(() => expect(s.results()).toHaveLength(1))
    voiceSaidStop()
    await waitFor(() => expect(state().paused).toBe(true))
    s.call('c-2', { action: 'click', x: 500, y: 500 })
    await waitFor(() => expect(s.results()).toHaveLength(2), { timeout: 3000 })
    expect(s.results()[1].status).not.toBe('completed')
    await waitFor(() => expect(sent('computer_stop')).toBe(1))
    expect(state().paused).toBe(false)
    expect(rust.fired).toEqual([])
    expect(surface()).toEqual({ mode: 'window', active: false, focus: false })
    // Windows run A22: the note said "The user stopped computer control." Nobody had.
    expect(state().stopped).toMatchObject({ reason: 'timeout', message: 'LU waited for your answer until the time for this task ran out, so computer control stopped.' })
  })
})

// ── The first use of computer control in a voice session ───────────────────

describe('the card "Allow computer control in this chat?" in a voice session', () => {
  beforeEach(() => { rust.chatAllowed = false })

  /** A screen call of the session that stops at the card, and what the voice loop is told meanwhile. */
  async function atTheCard(token: string) {
    const said: { kind: string; data: Record<string, unknown> }[] = []
    const off = announceComputerControl((kind, data) => said.push({ kind, data }), () => undefined)
    const run = { token, conversationId: token, standing: true } as AgentRunContext
    const call = executeComputerUse({ action: 'screenshot' }, run)
    await waitFor(() => expect(state().chatAsk).toMatchObject({ voice: true }))
    return { said, off, call, id: state().chatAsk!.id }
  }

  it('is told to the voice loop as a question that needs the click, so a spoken word is not a new request to the model', async () => {
    // Before 3.0.6 the voice loop heard nothing of the card. No task ran yet
    // and no question was open, so "Yes" went to the model as a turn of the
    // conversation: the model cancelled the waiting call and started it again.
    const { said, off, call, id } = await atTheCard('voice-card-1')
    expect(said).toEqual([{ kind: 'question', data: { id, text: CHAT_QUESTION, voice: false } }])
    // No session and no task: the question alone is what the voice loop goes by.
    expect(state().task).toBeNull()
    expect(sent('computer_session_begin')).toBe(0)

    answerComputerChatAsk(id, true)
    expect(await call).toMatch(/^Screenshot \[screen frame/)
    expect(said.map((m) => m.kind)).toEqual(['question', 'question-closed'])
    expect(said[1].data).toEqual({ id })
    off()
  })

  it('a spoken yes allows nothing: the card stays, Rust hears no answer', async () => {
    const { off, call, id } = await atTheCard('voice-card-2')
    voiceAnswered(id, 'yes')
    await new Promise((r) => setTimeout(r, 0))
    expect(state().chatAsk?.id).toBe(id)
    expect(rust.chatAnswers).toEqual([])
    answerComputerChatAsk(id, false)
    await call
    off()
  })

  it('a spoken no declines, as the Deny button does', async () => {
    const { said, off, call, id } = await atTheCard('voice-card-3')
    voiceAnswered(id, 'no')
    expect(await call).toBe(CHAT_PERMISSION_DENIED)
    expect(state().chatAsk).toBeNull()
    expect(rust.chatAnswers).toEqual([false])
    expect(sent('computer_session_begin')).toBe(0)
    expect(said.map((m) => m.kind)).toEqual(['question', 'question-closed'])
    off()
  })

  it('a spoken "stop" declines too, and stops nothing else: there is no session to stop', async () => {
    const { off, call } = await atTheCard('voice-card-4')
    voiceSaidStop()
    expect(await call).toBe(CHAT_PERMISSION_DENIED)
    expect(state().chatAsk).toBeNull()
    expect(rust.chatAnswers).toEqual([false])
    expect(sent('computer_pause')).toBe(0)
    expect(sent('computer_stop')).toBe(0)
    expect(state().stopped).toBeNull()
    off()
  })

  it('the card of a chat is not the voice session\'s to answer or to announce', async () => {
    const said: { kind: string; data: Record<string, unknown> }[] = []
    const off = announceComputerControl((kind, data) => said.push({ kind, data }), () => undefined)
    const call = executeComputerUse({ action: 'screenshot' }, { token: 'chat-card', conversationId: 'chat-card' } as AgentRunContext)
    await waitFor(() => expect(state().chatAsk).toMatchObject({ voice: false }))
    const id = state().chatAsk!.id
    expect(said).toEqual([])
    voiceAnswered(id, 'no')
    await new Promise((r) => setTimeout(r, 0))
    expect(state().chatAsk?.id).toBe(id)
    expect(rust.chatAnswers).toEqual([])
    answerComputerChatAsk(id, false)
    await call
    off()
  })
})
