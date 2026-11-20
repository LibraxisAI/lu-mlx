/**
 * The pause: the user reaches for the mouse or the keyboard while LU works
 * on the screen. Until 08.10.2026 that stopped the session at once. Now the
 * session pauses and the user is asked: take over, or let it continue.
 *
 * Rust holds the pause (engine tests in src-tauri). This file tests the
 * conversation around it against a stand-in of the engine: the refused call
 * waits for the answer however long it takes, "continue" makes the model
 * look again, "take over" ends the task like Stop, and nothing but the
 * user's answer lifts a pause.
 *
 * Run: npx vitest run src/api/__tests__/computer-pause.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

type Call = { cmd: string; args: Record<string, unknown> }

const APP = { key: 'notepad.exe', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe', bundleId: null }
const PAUSED = 'The user moved the mouse or pressed a key, so computer control is paused. Nothing runs until the user decides whether to take over or to let LU continue.'

/** A stand-in for the engine: autonomous, Notepad approved, and a hand that can reach in. */
const rust = {
  calls: [] as Call[],
  session: null as null | { id: string; chatId: string; autonomous: boolean; allowed: { key: string; scope: string }[]; stopped: string | null; frameId: number | null },
  paused: false,
  /** The next action finds the user's hand on the mouse. */
  hand: false,
  frames: 0,
  fired: [] as unknown[],
}

const refusal = (code: string, message: string) => ({ ok: false, refusal: { code, message } })
const front = () => ({ id: 4242, pid: 1, app: APP, title: 'Untitled', className: null, rect: { x: 0, y: 0, width: 10, height: 10 }, minimized: false, elevated: false, isSelf: false, verdict: 'allowed', blockReason: null, foreground: true })

async function fakeBackend(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  rust.calls.push({ cmd, args })
  const s = rust.session
  const stopped = () => refusal('stopped', s?.stopped === 'takeover'
    ? 'The user took over the mouse or keyboard, so computer control stopped. Do not continue. Tell the user what was done so far.'
    : 'The user stopped computer control. Do not continue. Tell the user what was done so far.')
  switch (cmd) {
    // The user said yes in every chat here. The question itself: computer-chat-permission.test.ts.
    case 'computer_chat_ask':
      return { ok: true, allowed: true }
    case 'computer_chat_answer':
      return { ok: true, allowed: args.allow === true }
    case 'computer_session_begin':
      if (rust.paused) return refusal('paused', PAUSED)
      rust.session = { id: 's1', chatId: String((args.options as { chatId?: string })?.chatId), autonomous: (args.options as { autonomous?: boolean })?.autonomous === true, allowed: [], stopped: null, frameId: null }
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
    case 'computer_takeover_answer':
      if (args.continue) rust.paused = false
      else {
        rust.paused = false
        if (s) s.stopped = 'takeover'
      }
      return { ok: true, paused: rust.paused, session: s }
    case 'computer_watch':
      if (rust.hand && s?.autonomous) {
        rust.hand = false
        rust.paused = true
      }
      return { ok: true, paused: rust.paused }
    case 'computer_windows':
      return { ok: true, foreground: front(), windows: [front()] }
    case 'computer_screen':
      if (!s) return refusal('no_session', 'There is no computer control session. Start one first.')
      if (s.stopped) return stopped()
      if (rust.paused) return refusal('paused', PAUSED)
      rust.frames += 1
      s.frameId = rust.frames
      return {
        ok: true, frameId: rust.frames, monitor: { id: 3, name: 'D', rect: { x: 0, y: 0, width: 1920, height: 1080 }, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1, primary: true },
        width: 1568, height: 882, scale: 0.8, cursor: [10, 20], foreground: front(), hiddenAreas: 0, mime: 'image/jpeg', image: 'QUJD',
      }
    case 'computer_action':
      if (!s) return refusal('no_session', 'There is no computer control session. Start one first.')
      if (s.stopped) return stopped()
      if (rust.hand) {
        rust.hand = false
        rust.paused = true
      }
      if (rust.paused) return refusal('paused', PAUSED)
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

import { SESSION_IDLE_MS, TIMED_OUT_SENTENCE, TIMED_OUT_WAITING_SENTENCE, computerControlBusy, executeComputerStep, executeComputerUse, resetComputerUseForTests, stopComputerControl, watchHeldStep } from '../computer-use'
import { HELD_MARK, runComputerTask } from '../computer-task'
import type { TaskDeps } from '../computer-task'
import { answerComputerPause, noteComputerPaused, resetComputerPauseForTests, takePauseNote } from '../../lib/computer/pause'
import { refusePendingComputerPrompt } from '../../lib/computer/prompts'
import { useComputerStore } from '../../stores/computerStore'
import type { AgentRunContext } from '../agent-context'

const run = (token: string) => ({ token }) as AgentRunContext
const commands = () => rust.calls.map((c) => c.cmd)
const answers = () => rust.calls.filter((c) => c.cmd === 'computer_takeover_answer')
const paused = () => useComputerStore.getState().paused

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  Object.assign(rust, { calls: [], session: null, paused: false, hand: false, frames: 0, fired: [] })
  refusePendingComputerPrompt()
  resetComputerUseForTests()
  resetComputerPauseForTests()
  useComputerStore.setState({
    enabled: true, alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], session: null, stopShortcut: null, pauseShortcut: null,
    autonomous: true, stopped: null, prompt: null, notice: null, currentApp: null, task: null, working: false, paused: false, monitorId: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the user moves the mouse while LU works on its own', () => {
  it('the action does not run and the call waits for the answer, with no time limit', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    let result: string | null = null
    void executeComputerUse({ action: 'click', x: 500, y: 500 }, run('r1')).then((text) => { result = text })
    await vi.waitFor(() => expect(paused()).toBe(true))
    expect(rust.fired).toEqual([])
    // Ten minutes later: still paused, nothing ran, nobody answered for the user.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(result).toBeNull()
    expect(paused()).toBe(true)
    expect(rust.fired).toEqual([])
    expect(answers()).toEqual([])
    expect(computerControlBusy()).toBe(true)
    await answerComputerPause(false)
  })

  it('"Let it continue" makes the model look again instead of running the old action', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const pending = executeComputerUse({ action: 'click', x: 500, y: 500 }, run('r1'))
    await vi.waitFor(() => expect(paused()).toBe(true))
    await answerComputerPause(true)
    const result = await pending
    expect(paused()).toBe(false)
    // The click from before the pause never fired.
    expect(rust.fired).toEqual([])
    expect(result).toMatch(/^Error: The user used the mouse or the keyboard, so LU paused and this step did not run\. The user let LU continue\./)
    expect(result).toContain('decide again from this new look')
    expect(result).toMatch(/Screenshot \[screen frame 2\]/)
    expect(useComputerStore.getState().stopped).toBeNull()
    // And the model can act again afterwards.
    expect(await executeComputerUse({ action: 'click', x: 400, y: 400 }, run('r1'))).toMatch(/^Did it in Notepad\./)
  })

  it('an action that ran before the pause counts as done, and the model still looks again', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    const pending = executeComputerUse({ action: 'click', x: 500, y: 500 }, run('r1'))
    // The pause shortcut lands while the screen settles after the click.
    await vi.waitFor(() => expect(rust.fired).toHaveLength(1))
    rust.paused = true
    await vi.waitFor(() => expect(paused()).toBe(true))
    await answerComputerPause(true)
    const result = await pending
    expect(result).toMatch(/^Did it in Notepad\. Then the user used the mouse or the keyboard, so LU paused\. The user let LU continue\./)
    expect(result).not.toMatch(/^Error/)
    expect(result).toMatch(/Screenshot \[screen frame 2\]/)
    expect(rust.fired).toHaveLength(1)
  })

  it('what the user typed while paused reaches the model with "continue"', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const pending = executeComputerUse({ action: 'type', text: 'hello' }, run('r1'))
    await vi.waitFor(() => expect(paused()).toBe(true))
    await answerComputerPause(true, '  use the   other document ')
    expect(await pending).toContain('The user added this instruction: "use the other document". Follow it.')
    // Once: the next call does not carry it again.
    expect(takePauseNote()).toBeNull()
  })

  it('"Take over" ends the task like Stop and binds the run', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, run('r1'))
    await vi.waitFor(() => expect(paused()).toBe(true))
    await answerComputerPause(false, 'this note is dropped')
    const step = await pending
    expect(step.end).toBe('stopped')
    expect(step.text).toMatch(/took over the mouse or keyboard/)
    expect(useComputerStore.getState().stopped).toMatchObject({ reason: 'takeover', runToken: 'r1' })
    expect(rust.fired).toEqual([])
    expect(takePauseNote()).toBeNull()
    // The same run stays stopped.
    expect(await executeComputerUse({ action: 'click', x: 1, y: 1 }, run('r1'))).toMatch(/^Error: .*took over/)
    expect(rust.fired).toEqual([])
  })

  it('a stop while the question is open answers it as "take over"', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, run('r1'))
    await vi.waitFor(() => expect(paused()).toBe(true))
    await stopComputerControl()
    const step = await pending
    expect(step.end).toBe('stopped')
    expect(paused()).toBe(false)
    expect(useComputerStore.getState().stopped?.reason).toBe('user')
    expect(answers()).toEqual([])
  })

  it('a pause seen between two actions holds the next call too', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    // The interface asked Rust and Rust saw the hand, or the shortcut was pressed.
    rust.paused = true
    noteComputerPaused()
    let result: string | null = null
    void executeComputerUse({ action: 'screenshot' }, run('r1')).then((text) => { result = text })
    await vi.advanceTimersByTimeAsync(5000)
    expect(result).toBeNull()
    await answerComputerPause(true)
    await vi.waitFor(() => expect(result).not.toBeNull())
    // A look is simply taken again.
    expect(result).toMatch(/^Screenshot \[screen frame 2\]/)
  })

  it('the session is not ended as idle while the user has not answered', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const pending = executeComputerUse({ action: 'click', x: 500, y: 500 }, run('r1'))
    await vi.waitFor(() => expect(paused()).toBe(true))
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS * 2 + 1000)
    expect(commands()).not.toContain('computer_session_end')
    expect(useComputerStore.getState().session).not.toBeNull()
    await answerComputerPause(true)
    await pending
  })

  it('if Rust still holds the pause, "continue" changes nothing here', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    let result: string | null = null
    void executeComputerUse({ action: 'click', x: 500, y: 500 }, run('r1')).then((text) => { result = text })
    await vi.waitFor(() => expect(paused()).toBe(true))
    // The answer does not get through to Rust.
    const spy = vi.spyOn(await import('../computer'), 'answerComputerTakeover').mockRejectedValueOnce(new Error('ipc'))
    await answerComputerPause(true)
    expect(paused()).toBe(true)
    expect(result).toBeNull()
    spy.mockRestore()
    await answerComputerPause(false)
  })

  it('the pill follows the display of the latest look, and the shortcut for pausing is known', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    expect(useComputerStore.getState().monitorId).toBe(3)
    expect(useComputerStore.getState().pauseShortcut).toBe('Ctrl+Alt+Space')
  })
})

describe('a screen task that is paused', () => {
  it('hands the note of the user to its own model and goes on from a new look', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    const asked: string[] = []
    let asks = 0
    const deps: TaskDeps = {
      resolve: async () => ({ model: 'm', label: 'Model', format: 'generic', sees: true }) as never,
      judge: async () => null,
      ask: async (_executor, messages) => {
        asks += 1
        asked.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'))
        if (asks === 1) {
          rust.hand = true
          return '{"thought":"click","action":"click","x":500,"y":500}'
        }
        return '{"thought":"finished","action":"done","summary":"Saved."}'
      },
      step: executeComputerStep,
      takeFrame: () => null,
      treeAvailable: async () => false,
      windows: async () => null,
      now: () => Date.now(),
      note: takePauseNote,
    }
    const pending = runComputerTask({ goal: 'Save the note' }, run('r1'), undefined, deps)
    await vi.waitFor(() => expect(paused()).toBe(true))
    await answerComputerPause(true, 'save it as draft.txt')
    const report = await pending
    expect(rust.fired).toEqual([])
    expect(asks).toBe(2)
    // The second question to the model carries the note, with the goal.
    expect(asked[1]).toContain('The user added while you worked: save it as draft.txt')
    expect(asked[1]).toContain('so LU paused and this step did not run')
    expect(report).toMatch(/^The screen task is finished\./)
  })
})

describe('a step that a pause held before it ran', () => {
  // Windows run A22: the paused view listed "Step 2: Type 3 characters", and nothing had been typed.
  it('is marked as not run in what the paused view shows, and reported to the tool card', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    const progress: string[] = []
    let asks = 0
    const deps: TaskDeps = {
      resolve: async () => ({ model: 'm', label: 'Model', format: 'generic', sees: true }) as never,
      judge: async () => null,
      ask: async () => {
        asks += 1
        if (asks === 1) {
          rust.hand = true
          return '{"thought":"type","action":"type","text":"two"}'
        }
        return '{"thought":"finished","action":"done","summary":"Done."}'
      },
      step: executeComputerStep,
      whenHeld: watchHeldStep,
      takeFrame: () => null,
      treeAvailable: async () => false,
      windows: async () => null,
      now: () => Date.now(),
      note: takePauseNote,
    }
    const pending = runComputerTask({ goal: 'Type two' }, { ...run('r1'), onToolProgress: (text: string) => progress.push(text) }, undefined, deps)
    await vi.waitFor(() => expect(paused()).toBe(true))
    await vi.waitFor(() => expect(useComputerStore.getState().task?.steps.at(-1)?.label).toBe(`Type 3 characters ${HELD_MARK}`))
    expect(useComputerStore.getState().task?.steps.at(-1)?.ok).toBeNull()
    expect(progress).toEqual(['Step 1: Type 3 characters.', 'Step 1 did not run: LU paused before it.'])
    expect(rust.fired).toEqual([])
    await answerComputerPause(true)
    await pending
  })

  it('an action that ran before the pause is not marked', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    let held = 0
    const off = watchHeldStep(() => { held += 1 })
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, run('r1'))
    // The pause shortcut lands while the screen settles after the click.
    await vi.waitFor(() => expect(rust.fired).toHaveLength(1))
    rust.paused = true
    await vi.waitFor(() => expect(paused()).toBe(true))
    expect(held).toBe(0)
    await answerComputerPause(true)
    await pending
    off()
  })
})

describe('the time of a call runs out', () => {
  const timeout = () => new DOMException('The tool call ran out of time.', 'TimeoutError')

  it('while paused: the note says LU waited, not that the user stopped', async () => {
    // Windows run A22: nine minutes in the paused view, then "The user stopped computer control."
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const control = new AbortController()
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, run('r1'), control.signal)
    await vi.waitFor(() => expect(paused()).toBe(true))
    control.abort(timeout())
    const step = await pending
    expect(step.end).toBe('stopped')
    expect(step.text).toBe(`Error: ${TIMED_OUT_WAITING_SENTENCE} Do not continue. Tell the user what was done so far.`)
    expect(useComputerStore.getState().stopped).toMatchObject({ reason: 'timeout', message: TIMED_OUT_WAITING_SENTENCE })
    expect(TIMED_OUT_WAITING_SENTENCE).not.toMatch(/user stopped/i)
    expect(paused()).toBe(false)
    expect(commands()).toContain('computer_stop')
    expect(rust.fired).toEqual([])
  })

  it('while at work: the note names the time', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    await stopComputerControl('timeout')
    expect(useComputerStore.getState().stopped).toMatchObject({ reason: 'timeout', message: TIMED_OUT_SENTENCE })
    expect(commands()).toContain('computer_stop')
  })

  it('the Stop of the chat is still the user stopping', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.hand = true
    const control = new AbortController()
    const pending = executeComputerStep({ action: 'click', x: 500, y: 500 }, run('r1'), control.signal)
    await vi.waitFor(() => expect(paused()).toBe(true))
    control.abort()
    await pending
    expect(useComputerStore.getState().stopped).toMatchObject({ reason: 'user', message: 'The user stopped computer control.' })
  })
})

describe('only the user lifts a pause', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const sources: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name !== '__tests__' && name !== 'node_modules') walk(full)
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) sources.push({ path: relative(root, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') })
    }
  }
  walk(join(root, 'src'))
  const users = (word: string) => sources.filter((file) => file.text.includes(word)).map((file) => file.path).sort()

  it('the command that answers a pause is sent from one place', () => {
    expect(users('computer_takeover_answer')).toEqual(['src/api/backend.ts', 'src/api/computer.ts'])
    expect(users('answerComputerTakeover')).toEqual(['src/api/computer.ts', 'src/lib/computer/pause.ts'])
  })

  it('and that place is called by the paused view alone, never by a tool', () => {
    expect(users('answerComputerPause')).toEqual(['src/components/computer/ComputerSurface.tsx', 'src/lib/computer/pause.ts'])
    // The tools wait for the answer. They cannot give it.
    const tools = sources.filter((file) => /^src\/api\/(computer-use|computer-task|computer-executor)\.ts$/.test(file.path))
    expect(tools).toHaveLength(3)
    for (const tool of tools) expect(tool.text).not.toMatch(/answerComputer(Pause|Takeover)/)
  })

  it('a paused session is not replaced by a new one from the tool', async () => {
    await executeComputerUse({ action: 'screenshot' }, run('r1'))
    rust.paused = true
    rust.session = null
    useComputerStore.getState().setSession(null)
    let result: string | null = null
    void executeComputerUse({ action: 'click', x: 1, y: 1 }, run('r1')).then((text) => { result = text })
    await vi.waitFor(() => expect(paused()).toBe(true))
    expect(result).toBeNull()
    expect(rust.session).toBeNull()
    expect(answers()).toEqual([])
    await answerComputerPause(false)
  })
})
