/**
 * Screenshots of computer control in the conversation.
 *
 * The owner wants to see what LU saw. The rules this file holds: the user gets
 * exactly the picture the model got, nothing while a password field has the
 * focus, a hard limit on count and bytes, and no picture in anything that is
 * written to disk (pictures in the chat store once ran the app out of memory).
 *
 * Run: npx vitest run src/api/__tests__/screen-shots-in-the-conversation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** A picture large enough that it would show in any store it leaked into. */
const MARK = 'TESTPICTUREDATA'
const BIG = MARK + 'A'.repeat(400_000 - MARK.length)

const rust = {
  session: null as null | { id: string; allowed: string[] },
  chat: '',
  passwordFocused: false,
  frames: 0,
  image: BIG,
}
const refusal = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, refusal: { code, message, ...extra } })
const app = { key: 'notepad.exe', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe', bundleId: null }
const front = () => ({
  id: 4242, pid: 1, app, title: 'Untitled', className: null, rect: { x: 0, y: 0, width: 10, height: 10 }, minimized: false, elevated: false,
  isSelf: false, verdict: 'allowed', blockReason: null, foreground: true,
})

async function fakeBackend(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case 'computer_status':
      return { ok: true, platform: 'windows', inputAvailable: true, inputError: null, treeAvailable: false, autonomyAvailable: true, stopShortcut: 'Ctrl+Alt+Esc', stopShortcutActive: true, session: rust.session }
    // The user said yes in every chat here. The question itself: computer-chat-permission.test.ts.
    case 'computer_chat_ask':
      return { ok: true, allowed: true }
    case 'computer_chat_answer':
      return { ok: true, allowed: args.allow === true }
    case 'computer_session_begin':
      rust.session = { id: 's1', allowed: [] }
      rust.chat = String((args.options as { chatId?: string })?.chatId)
      return { ok: true, session: { id: 's1', chatId: rust.chat, autonomous: true, allowed: [], stopped: null, frameId: null }, stopShortcut: 'Ctrl+Alt+Esc' }
    case 'computer_session_allow_app':
      return { ok: true, session: { id: 's1', chatId: rust.chat, autonomous: true, allowed: [{ key: String(args.appKey), scope: 'session' }], stopped: null, frameId: null } }
    case 'computer_windows':
      return { ok: true, foreground: front(), windows: [front()] }
    case 'computer_screen': {
      if (rust.passwordFocused) return refusal('password_field', 'A password field has the focus, so the screenshot is withheld. Ask the user to type the password themselves and to say when they are done.')
      rust.frames += 1
      const noImage = (args.options as { noImage?: boolean })?.noImage === true
      return {
        ok: true, frameId: rust.frames, monitor: { id: 1, name: 'D', rect: { x: 0, y: 0, width: 1920, height: 1080 }, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1, primary: true },
        width: 1568, height: 882, scale: 0.8, cursor: null, foreground: front(), hiddenAreas: 1,
        mime: noImage ? null : 'image/jpeg', image: noImage ? null : rust.image,
      }
    }
    case 'computer_tree':
      return { ok: true, window: front(), dropped: 0, passwordFocused: false, warnings: [], nodes: [{ depth: 1, role: 'Button', name: 'Save', rect: [1, 2, 3, 4], enabled: true }] }
    case 'computer_action': {
      const request = args.request as { action: Record<string, unknown> }
      return { ok: true, performed: `Did ${String(request.action.type)} in Notepad.`, app, windowTitle: 'Untitled' }
    }
    default:
      return { ok: true }
  }
}

vi.mock('../backend', () => ({
  backendCall: (cmd: string, args?: Record<string, unknown>) => fakeBackend(cmd, args),
  isTauri: () => true,
}))

import { executeComputerStep, executeComputerUse, resetComputerUseForTests } from '../computer-use'
import { runComputerTask, type TaskDeps } from '../computer-task'
import type { ResolvedExecutor } from '../computer-executor'
import { runForCall, type AgentRunContext } from '../agent-context'
import { APPROVE_ALL, executeParallel } from '../agents/tool-executor'
import {
  MAX_SCREEN_SHOTS,
  MAX_SCREEN_SHOT_BYTES,
  WITHHELD_SHOT_TEXT,
  base64Bytes,
  clearScreenShots,
  keepScreenShot,
  screenShotsOf,
  setScreenShotUrlsForTests,
  useScreenShotStore,
} from '../../lib/computer/screen-shots'
import { reduceVoiceSession, VOICE_IDLE } from '../../lib/voice/session-state'
import { useChatStore } from '../../stores/chatStore'
import { useComputerStore } from '../../stores/computerStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useMemoryStore } from '../../stores/memoryStore'

const plainRun = (token: string) => ({ token }) as AgentRunContext
const call = (id: string) => runForCall(plainRun('r1'), id)

/** Object URLs of the browser, counted. */
const made: { url: string; data: string }[] = []
const released: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  Object.assign(rust, { session: null, passwordFocused: false, frames: 0, image: BIG })
  made.length = 0
  released.length = 0
  setScreenShotUrlsForTests({
    make: (frame) => {
      const url = `blob:test/${made.length + 1}`
      made.push({ url, data: frame.data })
      return url
    },
    release: (url) => { released.push(url) },
  })
  clearScreenShots()
  released.length = 0
  resetComputerUseForTests()
  useComputerStore.setState({ enabled: true, alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], executorModel: null, task: null, session: null, stopShortcut: null, autonomous: true, stopped: null, prompt: null, notice: null, currentApp: null })
})

afterEach(() => {
  setScreenShotUrlsForTests(null)
  vi.useRealTimers()
})

describe('the tool call a picture belongs to', () => {
  it('the executor hands every tool its own call id, on the one run object', async () => {
    const run = plainRun('r1')
    const seen: (string | undefined)[] = []
    await executeParallel(
      [{ id: 'call-a', toolName: 't', args: {}, run }, { id: 'call-b', toolName: 't', args: {}, run }],
      {
        getTool: () => ({ name: 't', inputSchema: { type: 'object', properties: {} } }) as never,
        awaitApproval: APPROVE_ALL,
        execute: async (_name, _args, context) => {
          seen.push(context?.toolCallId)
          // A tool writes to its run. The write must reach the run of the hook.
          if (context) context.workspace = { path: `/w/${context.toolCallId}` } as never
          expect(context?.token).toBe('r1')
          return 'ok'
        },
      },
    )
    expect(seen.sort()).toEqual(['call-a', 'call-b'])
    expect(run.workspace).not.toBeUndefined()
    expect(run.toolCallId).toBeUndefined()
  })

  it('a field the hook sets after the start is seen through the view', () => {
    const run = plainRun('r1')
    const view = runForCall(run, 'call-1')
    const abort = new AbortController()
    run.abortSignal = abort.signal
    expect(view.abortSignal).toBe(abort.signal)
    expect(view.toolCallId).toBe('call-1')
  })
})

describe('what is kept', () => {
  it('a look lands on the card of its call: the picture the model was given, and nothing else in the text', async () => {
    const text = await executeComputerUse({ action: 'screenshot' }, call('call-1'))
    expect(text).toMatch(/Screenshot \[screen frame 1\]/)
    expect(text).not.toContain(MARK)
    expect(text).not.toContain('blob:')

    const shots = screenShotsOf('call-1')
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ callId: 'call-1', frameId: 1, url: 'blob:test/1', bytes: base64Bytes(BIG), caption: 'Screen' })
    // Exactly the bytes that were parked for the model: the capture with its blacked out areas.
    expect(made).toEqual([{ url: 'blob:test/1', data: BIG }])
    expect(text).toMatch(/Black areas are windows that are off limits/)
    expect(screenShotsOf('call-2')).toEqual([])
  })

  it('an action keeps the look after it', async () => {
    await executeComputerUse({ action: 'key', keys: 'tab' }, call('call-7'))
    expect(screenShotsOf('call-7').map((s) => s.frameId)).toEqual([1])
  })

  it('a call nobody shows keeps no picture', async () => {
    await executeComputerUse({ action: 'screenshot' }, plainRun('r1'))
    await executeComputerUse({ action: 'screenshot' })
    expect(useScreenShotStore.getState().shots).toEqual([])
    expect(made).toEqual([])
  })

  it('a look for the element list alone takes no picture', async () => {
    await executeComputerUse({ action: 'read_tree' }, call('call-1'))
    expect(useScreenShotStore.getState().shots).toEqual([])
  })

  it('no picture while a password field has the focus: one line instead, once', async () => {
    rust.passwordFocused = true
    const text = await executeComputerUse({ action: 'screenshot' }, call('call-1'))
    expect(text).toMatch(/^Error: A password field has the focus, so the screenshot is withheld/)
    await executeComputerUse({ action: 'screenshot' }, call('call-1'))
    const shots = screenShotsOf('call-1')
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ url: null, frameId: null, bytes: 0, caption: WITHHELD_SHOT_TEXT })
    expect(made).toEqual([])

    // The field loses the focus: pictures again, and a new line if it comes back.
    rust.passwordFocused = false
    await executeComputerUse({ action: 'screenshot' }, call('call-1'))
    rust.passwordFocused = true
    await executeComputerUse({ action: 'screenshot' }, call('call-1'))
    expect(screenShotsOf('call-1').map((s) => s.url)).toEqual([null, 'blob:test/1', null])
  })
})

describe('the hard limit', () => {
  const small = (n: number) => ({ data: 'QUJD'.repeat(250) + String(n).padStart(4, '0'), mimeType: 'image/jpeg' })

  it('keeps the newest pictures by count and releases the oldest', () => {
    for (let i = 1; i <= MAX_SCREEN_SHOTS + 5; i++) keepScreenShot('call-1', i, small(i))
    const shots = useScreenShotStore.getState().shots
    expect(shots).toHaveLength(MAX_SCREEN_SHOTS)
    expect(shots[0].frameId).toBe(6)
    expect(shots[shots.length - 1].frameId).toBe(MAX_SCREEN_SHOTS + 5)
    expect(released).toEqual(['blob:test/1', 'blob:test/2', 'blob:test/3', 'blob:test/4', 'blob:test/5'])
  })

  it('keeps the newest pictures by bytes, over all calls', () => {
    const third = { data: 'A'.repeat(Math.floor((MAX_SCREEN_SHOT_BYTES / 3) * (4 / 3))), mimeType: 'image/jpeg' }
    for (let i = 1; i <= 5; i++) keepScreenShot(`call-${i}`, i, third)
    const shots = useScreenShotStore.getState().shots
    const total = shots.reduce((sum, s) => sum + s.bytes, 0)
    expect(total).toBeLessThanOrEqual(MAX_SCREEN_SHOT_BYTES)
    expect(shots.map((s) => s.frameId)).toEqual([3, 4, 5])
    expect(released).toEqual(['blob:test/1', 'blob:test/2'])
  })

  it('a picture larger than the whole budget is not kept at all', () => {
    keepScreenShot('call-1', 1, small(1))
    keepScreenShot('call-1', 2, { data: 'A'.repeat(Math.ceil(MAX_SCREEN_SHOT_BYTES * 1.5)), mimeType: 'image/png' })
    expect(useScreenShotStore.getState().shots.map((s) => s.frameId)).toEqual([1])
  })

  it('the limits are small enough to mean something', () => {
    expect(MAX_SCREEN_SHOTS).toBeLessThanOrEqual(32)
    expect(MAX_SCREEN_SHOT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024)
  })
})

describe('a screen task', () => {
  const EXECUTOR: ResolvedExecutor = { model: 'ollama-vision', label: 'Vision 9B', format: 'generic', sees: true }

  it('gives every step its picture, captioned without the typed text', async () => {
    const answers = [
      '{"thought":"Click into the note.","action":"click","x":500,"y":400}',
      '{"thought":"Type it.","action":"type","text":"my secret words"}',
      '{"thought":"Done.","action":"done","summary":"The text is in the note."}',
    ]
    const deps: TaskDeps = {
      resolve: async () => EXECUTOR,
      ask: async () => answers.shift()!,
      judge: async () => null,
      step: executeComputerStep,
      takeFrame: () => null,
      treeAvailable: async () => false,
      windows: async () => null,
      now: () => 0,
    }
    const report = await runComputerTask({ goal: 'Write into the note' }, call('task-1'), undefined, deps)
    expect(report).toMatch(/^The screen task is finished\./)
    expect(screenShotsOf('task-1').map((s) => s.caption)).toEqual([
      'Before the first step',
      'Step 1: Click at 500, 400',
      'Step 2: Type 15 characters',
    ])
    expect(JSON.stringify(screenShotsOf('task-1'))).not.toContain('my secret words')
    // What the brain reads, and what a chat stores as the result of the call.
    expect(report).not.toContain(MARK)
    expect(report).not.toContain('blob:')
  })
})

describe('nothing large is written to disk', () => {
  it('the store of the pictures has no persistence at all', () => {
    expect((useScreenShotStore as unknown as { persist?: unknown }).persist).toBeUndefined()
    const source = readFileSync(resolve(process.cwd(), 'src/lib/computer/screen-shots.ts'), 'utf8')
    expect(source).not.toMatch(/zustand\/middleware|localStorage|indexedDB|idb|storage-quota|coalescedStorage|backendCall/)
  })

  it('after a task with pictures, no persisted store holds a picture or a way back to one', async () => {
    const answers = ['{"thought":"Click.","action":"click","x":500,"y":400}', '{"thought":"Done.","action":"done","summary":"Clicked."}']
    const deps: TaskDeps = {
      resolve: async () => ({ model: 'm', label: 'M', format: 'generic', sees: true }),
      ask: async () => answers.shift()!,
      judge: async () => null,
      step: executeComputerStep,
      takeFrame: () => null,
      treeAvailable: async () => false,
      windows: async () => null,
      now: () => 0,
    }
    const report = await runComputerTask({ goal: 'Click the button' }, call('task-9'), undefined, deps)
    expect(screenShotsOf('task-9').length).toBeGreaterThanOrEqual(2)

    // The result as the two surfaces store it: a chat message with its tool
    // block, and the tool line of a voice session.
    const convId = useChatStore.getState().createConversation('m', '')
    useChatStore.getState().addMessage(convId, {
      id: 'a1', role: 'assistant', content: '', timestamp: 1,
      agentBlocks: [{ id: 'b1', phase: 'tool_call', content: 'Running: computer_task', timestamp: 1, toolCalls: [{ id: 'task-9', toolName: 'computer_task', args: { goal: 'Click the button' }, status: 'completed', result: report, timestamp: 1 }] }],
    } as never)
    let voice = reduceVoiceSession(VOICE_IDLE, { type: 'start', at: 1, muted: false })
    voice = reduceVoiceSession(voice, { type: 'ready' })
    voice = reduceVoiceSession(voice, { type: 'tool-running', id: 'task-9', name: 'computer_task', args: { goal: 'Click the button' } })
    voice = reduceVoiceSession(voice, { type: 'tool-done', id: 'task-9', status: 'completed', result: report })

    const written: Record<string, string> = { voiceSession: JSON.stringify(voice) }
    for (const [name, store] of Object.entries({ chat: useChatStore, computer: useComputerStore, voice: useVoiceStore, memory: useMemoryStore })) {
      const options = (store as unknown as { persist: { getOptions: () => { partialize?: (s: unknown) => unknown } } }).persist.getOptions()
      const state = store.getState() as unknown
      written[name] = JSON.stringify(options.partialize ? options.partialize(state) : state)
    }
    expect(written.chat).toContain('The screen task is finished')
    for (const [name, json] of Object.entries(written)) {
      expect(json, name).not.toContain(MARK)
      expect(json, name).not.toContain('blob:')
      expect(json, name).not.toContain('data:image')
      // A chat with one screen task stays a few kB, whatever the pictures weigh.
      expect(json.length, name).toBeLessThan(50_000)
    }
  })

  it('no store, no memory code and no history writer reaches for the pictures', () => {
    const root = resolve(process.cwd(), 'src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) { if (entry !== '__tests__') walk(path) } else if (/\.(ts|tsx)$/.test(entry)) files.push(path)
      }
    }
    walk(root)
    const users = files.filter((file) => /computer\/screen-shots['"]/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length + 1).replace(/\\/g, '/')).sort()
    // The capture, the task loop that captions, and the strip that shows.
    expect(users).toEqual(['api/computer-task.ts', 'api/computer-use.ts', 'components/computer/ScreenShotStrip.tsx'])
  })
})
