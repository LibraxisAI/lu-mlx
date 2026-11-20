// The `computer_task` tool: a whole task on the screen, handed over in one call.
//
// `computer_use` is one action per call, and the model that calls it has to
// see the screenshot. A voice session gets tool results as text only, and many
// chat models cannot see images. So this tool runs the loop here in the app:
// take a screenshot, ask a model that can see (the executor) for the next
// action, run it, look again, until the goal is reached.
//
// There is no second way to the screen in this file. Every screenshot and
// every action is a call of `executeComputerStep`, the same function the
// `computer_use` tool is. The app approvals, the confirmations, the blocklist,
// the password rule, Stop, the shortcut and the takeover all apply to each
// step exactly as they apply to a single call, because each step IS a single
// call. The executor only decides what to ask for.
//
// The brain gets a short text back: what was done, how the screen looks now,
// or why the task stopped.

import type { MCPToolDefinition, ToolArgs } from './mcp/types'
import type { AgentRunContext } from './agent-context'
import type { ChatMessage } from './providers/types'
import { COMPUTER_OFF_ERROR, computerChatGate, computerFrontAllowed, executeComputerStep, watchHeldStep } from './computer-use'
import type { ComputerStep, StepEnd } from './computer-use'
import { getComputerStatus, getComputerWindows } from './computer'
import type { ComputerWindow } from './computer'
import { askExecutor, checkGoalReached, NO_EXECUTOR_ERROR, resolveExecutor } from './computer-executor'
import type { GoalCheckInput, ResolvedExecutor } from './computer-executor'
import {
  buildExecutorSystemPrompt,
  describeExecutorCall,
  parseExecutorAnswer,
} from '../lib/computer/executor-format'
import type { ExecutorDecision } from '../lib/computer/executor-format'
import { frameIdInResult, takeFrame } from '../lib/computer/frames'
import { captionScreenShot } from '../lib/computer/screen-shots'
import { takePauseNote } from '../lib/computer/pause'
import type { PendingFrame } from '../lib/computer/frames'
import { COMPUTER_TASK_TOOL_NAME } from '../lib/computer/prompt'
import { sanitizeScreenText, wrapScreenData } from '../lib/computer/screen-data'
import { useComputerStore } from '../stores/computerStore'
import type { ComputerTaskStep, ScreenInput } from '../stores/computerStore'
import { log } from '../lib/logger'

export const COMPUTER_TASK_TOOL: MCPToolDefinition = {
  name: COMPUTER_TASK_TOOL_NAME,
  description:
    'Hand a whole task on the user\'s screen to the screen operator. It looks at the screen and clicks and types step by step until the goal is reached, then reports what it did and what the screen shows. '
    + 'Use it for anything that takes more than one action, and always when you cannot see images. Describe the goal completely in plain words; the operator knows nothing else about the conversation. '
    + 'The user approves each app and confirms actions on the way, so a task can take a few minutes. Never put passwords or codes in the goal.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What should be true on the screen when the task is done, in one or two sentences.' },
      app: { type: 'string', description: 'The app to work in, when the user named one. It must already be open.' },
    },
    required: ['goal'],
  },
  category: 'desktop',
  source: 'builtin',
}

/** A task that needs more actions than this is stuck, not long. */
export const TASK_MAX_STEPS = 25
/** What the label of a step says when a pause held it before it ran. */
export const HELD_MARK = '(not run: LU paused first)'
/** Wall time for one task, the waits for the user included. */
export const TASK_TIME_LIMIT_MS = 8 * 60 * 1000
const MAX_GOAL_CHARS = 1000
/** Answers in a row the executor may get wrong before the task gives up. */
const MAX_BAD_ANSWERS = 3
/**
 * Steps that may land on something off limits before the task gives up. A
 * task asked for in the chat starts with LU's own window in front, and LU is
 * off limits: the first move of the operator is often one that needs another
 * window in front first. It reads the refusal and picks that window.
 */
const MAX_BLOCKED = 3
/** The same action this many times in a row means the screen does not react. */
const MAX_REPEATS = 3
/** Earlier steps kept word for word in the executor's conversation. */
/**
 * The same action this often within the last few steps means the operator
 * goes in circles (open a menu, close it, open it again). Seen with a small
 * screen model that had reached the goal after two steps and then clicked the
 * same menu ten more times until the step limit.
 */
const MAX_RETURNS = 4
const RETURN_WINDOW = 8
const HISTORY_STEPS = 8
/**
 * How often one task may ask whether its goal is already reached. Each check
 * is one more look of the model, so it is asked only when the operator starts
 * to repeat itself or runs into a limit.
 */
const MAX_GOAL_CHECKS = 2
/**
 * How often LU's own panel may step out of the way of one task without the
 * step counting. Each time the operator aimed at a spot under the panel,
 * nothing ran, the panel moved and the operator got a new look. After this
 * many, such a step counts like any other that did not work.
 */
export const MAX_PANEL_MOVES = 4
/** What the operator reads after the panel moved out of its way. */
export const PANEL_MOVED_CORRECTION = "Your last action did not run and does not count: LU's own panel was over that spot. The panel has moved and the picture is new. Decide again from what you see now."
const MAX_TREE_CHARS = 4000

/** Everything the loop touches outside itself. Replaced in tests. */
export interface TaskDeps {
  resolve: () => Promise<ResolvedExecutor | null>
  /** `elements`: this step comes with a list of numbered elements. */
  ask: (executor: ResolvedExecutor, messages: ChatMessage[], signal?: AbortSignal, elements?: boolean) => Promise<string>
  /** Is the goal reached, judged from the screen as it is now? Null without a clear answer. */
  judge: (executor: ResolvedExecutor, input: GoalCheckInput, signal?: AbortSignal) => Promise<{ reached: boolean; summary: string } | null>
  step: (args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal) => Promise<ComputerStep>
  /** The yes of the user for this chat, asked before the task shows anywhere. Null: allowed. Every step asks for it again by itself. */
  chatGate?: (run: AgentRunContext | undefined, signal: AbortSignal | undefined) => Promise<string | null>
  /** Be told when the running step was held by a pause before it did anything. */
  whenHeld?: (listener: () => void) => () => void
  takeFrame: (frameId: number) => PendingFrame | null
  treeAvailable: () => Promise<boolean>
  /** The open windows and the one in front, to bring the app of the task forward. */
  windows: () => Promise<{ foreground: ComputerWindow | null; windows: ComputerWindow[] } | null>
  now: () => number
  /** What the user typed while the task was paused, once. */
  note?: () => string | null
}

const realDeps: TaskDeps = {
  resolve: resolveExecutor,
  ask: askExecutor,
  judge: checkGoalReached,
  step: executeComputerStep,
  chatGate: computerChatGate,
  whenHeld: watchHeldStep,
  takeFrame,
  treeAvailable: async () => {
    const status = await getComputerStatus().catch(() => null)
    return !!status && status.ok && status.treeAvailable
  },
  windows: async () => {
    const listed = await getComputerWindows().catch(() => null)
    return listed && listed.ok ? { foreground: listed.foreground, windows: listed.windows } : null
  },
  now: () => Date.now(),
  note: takePauseNote,
}

const store = () => useComputerStore.getState()

/** What the status bar says while a model without image input works. */
export const BLIND_NOTICE = (label: string): string =>
  `${label} works from the list of buttons and fields of the window in front, without a picture.`

interface Done {
  n: number
  label: string
  /** The first line of what the tool answered: "Clicked at 662, 511 in Notes." */
  outcome: string
  ok: boolean
  /** The executor's own step, replayed to it as its earlier answer. */
  said: string
}

const END_SENTENCE: Record<StepEnd, string> = {
  stopped: 'The user stopped computer control.',
  no_chat: 'The user did not allow computer control in this chat.',
  denied: 'The user did not allow LU to control that app.',
  declined: 'The user declined an action.',
  blocked: 'The next step was off limits.',
  off: 'Computer control is turned off.',
  cancelled: 'The task was cancelled.',
}

/** The lines of a tool answer that describe the screen, without the image hint. */
function observationText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^The picture follows as an image/.test(line))
    .join('\n')
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}

/**
 * What a model has to read first when a task was ended from outside: that it
 * is not done, and what did run. A small model that read "stopped" and a
 * goal in the same answer told the user the goal was reached (voice, box,
 * 10.10.2026: "the word banana was typed" after Take over, with nothing
 * typed). So the sentence is built from the steps that really ran.
 */
export function unfinished(done: readonly { ok: boolean; outcome: string }[]): string {
  const ran = done.filter((step) => step.ok)
  const head = 'It did NOT finish and the goal is NOT reached.'
  if (ran.length === 0) return `${head} It was stopped before the first action: nothing was typed, clicked or changed on the screen.`
  const what = ran.map((step) => sanitizeScreenText(step.outcome).replace(/\s+/g, ' ').trim()).join(' ')
  return `${head} Only this ran before it was stopped: ${what} Nothing after that was done.`
}

function report(head: string, goal: string, done: Done[], tail: string[]): string {
  const lines = [head, `Goal: ${goal}`]
  if (done.length === 0) lines.push('No action was taken on the screen.')
  else {
    lines.push(`Actions taken (${done.length}):`)
    for (const step of done) lines.push(`${step.n}. ${step.outcome}`)
  }
  lines.push(...tail)
  return lines.join('\n')
}

/**
 * What the executor is shown: its rules, the goal, the last few steps as a
 * conversation, and the newest screenshot. Only the newest screenshot is a
 * picture; an old one is out of date and would only fill the window.
 */
export function buildExecutorMessages(input: {
  executor: ResolvedExecutor
  goal: string
  app: string | null
  done: Done[]
  observation: string
  tree: string | null
  frame: PendingFrame | null
  correction: string | null
  /** What the user added while the task was paused. Theirs, so it stands with the goal. */
  notes?: string[]
}): ChatMessage[] {
  const { executor, goal, app, done } = input
  const messages: ChatMessage[] = [{ role: 'system', content: buildExecutorSystemPrompt(executor.format, executor.sees, input.tree !== null) }]
  const task = [`Goal: ${goal}`]
  if (app) task.push(`Work in this app: ${app}`)
  for (const note of input.notes ?? []) task.push(`The user added while you worked: ${note}`)
  messages.push({ role: 'user', content: task.join('\n') })

  const shown = done.slice(-HISTORY_STEPS)
  if (shown.length < done.length) {
    messages.push({ role: 'assistant', content: `{"thought":"${done.length - shown.length} earlier steps are not shown."}` })
    messages.push({ role: 'user', content: 'Continue.' })
  }
  for (const step of shown) {
    messages.push({ role: 'assistant', content: step.said })
    messages.push({ role: 'user', content: `<tool_output>\n${sanitizeScreenText(step.outcome)}\n</tool_output>` })
  }

  const now = [`<observation>\n${input.observation}`]
  if (input.tree) now.push(input.tree)
  now.push('</observation>')
  if (!executor.sees) {
    now.push(input.tree
      ? 'You have no picture. Work from the list of elements above.'
      : 'You have no picture, and the elements of the window in front are not listed: it is not a window the user approved yet, or it does not report its elements. Bring the window you need to the front with focus_window and an id from the list of open windows, or ask.')
  } else if (!input.frame) now.push('No picture of the screen is available for this step. Decide from the text above, or ask.')
  if (input.correction) now.push(input.correction)
  now.push(done.length === 0 ? 'What is the first action?' : 'What is the next action?')
  const last: ChatMessage = { role: 'user', content: now.join('\n') }
  if (input.frame) last.images = [input.frame]
  messages.push(last)
  return messages
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** The names a window's app goes by: its words, and its program file without the ending. */
function appNames(window: ComputerWindow): string[] {
  const program = window.app.key.replace(/\.exe$/i, '').split('.').pop() ?? ''
  return [...words(window.app.name).filter((w) => w.length >= 4), ...words(program).filter((w) => w.length >= 3)]
}

/**
 * The window a task should start in, when that is not the one in front.
 *
 * A task asked for in the chat starts with LU's own window in front. The
 * operator's first move then lands on LU, which is off limits, and a small
 * model does not always think of switching windows first. When the task names
 * an open app (the `app` argument, or the goal while LU itself is in front),
 * and exactly one app goes by that name, its window is brought forward before
 * the first look. That goes the guarded way: the question per app and the
 * confirmation apply as for any other step.
 */
export function startWindow(
  listed: { foreground: ComputerWindow | null; windows: ComputerWindow[] } | null,
  app: string | null,
  goal: string,
): ComputerWindow | null {
  if (!listed) return null
  const front = listed.foreground
  const named = app ? words(app) : front?.isSelf ? words(goal) : []
  if (named.length === 0) return null
  const hits = listed.windows.filter((w) => !w.isSelf && w.verdict !== 'blocked' && w.title.trim() !== '' && appNames(w).some((n) => named.includes(n)))
  const apps = new Set(hits.map((w) => w.app.key))
  if (apps.size !== 1) return null
  const target = hits.find((w) => !w.minimized) ?? hits[0]
  return front && front.id === target.id ? null : target
}

function setProgress(steps: ComputerTaskStep[], phase: 'looking' | 'deciding' | 'acting'): void {
  const task = store().task
  if (task) store().setTask({ ...task, steps, phase })
}

/**
 * THE switch for a model with image input on a system that lists the
 * elements of a window (Windows).
 *
 * true: it gets the picture and the list ("has the model image input, it
 * works with it right away").
 * false: it works from the list alone there, like a model without image
 * input. Where there is no list it gets the picture either way.
 */
export const SEEING_MODEL_GETS_THE_PICTURE = true

export type ScreenWay = 'picture+list' | 'picture' | 'list' | 'none'

/**
 * What the operator is shown. `input` is the hidden switch of the store:
 * 'list' and 'picture' force one way for a measurement, 'auto' is the rule.
 * A model without image input works from the list, and where the system has
 * none it has nothing to go by.
 */
export function screenWay(input: ScreenInput, sees: boolean, hasList: boolean, picture = SEEING_MODEL_GETS_THE_PICTURE): ScreenWay {
  if (!sees) return hasList ? 'list' : 'none'
  if (!hasList) return 'picture'
  if (input === 'list') return 'list'
  if (input === 'picture') return 'picture'
  return picture ? 'picture+list' : 'list'
}

const NO_ELEMENTS_CORRECTION = 'There is no list of elements in this step, so "element" names nothing. Name the place with x and y from the screenshot.'

/** Run one task to its end. Never throws; every ending is a sentence. */
export async function runComputerTask(
  args: ToolArgs,
  run?: AgentRunContext,
  signal?: AbortSignal,
  deps: TaskDeps = realDeps,
): Promise<string> {
  if (!store().enabled) return COMPUTER_OFF_ERROR
  const goal = typeof args.goal === 'string' ? args.goal.replace(/\s+/g, ' ').trim() : ''
  if (!goal) return 'Error: "goal" is missing. Say in one or two sentences what should be true on the screen at the end.'
  if (goal.length > MAX_GOAL_CHARS) return `Error: The goal is too long. Keep it under ${MAX_GOAL_CHARS} characters.`
  const app = typeof args.app === 'string' && args.app.trim() ? args.app.replace(/\s+/g, ' ').trim().slice(0, 80) : null
  if (store().task) return 'Error: Another screen task is still running. Wait for it to finish, or ask the user to stop it.'
  // The yes of the user for this chat comes first: before a model is picked,
  // before the task shows anywhere, before the first look.
  const refused = deps.chatGate ? await deps.chatGate(run, signal) : null
  if (refused !== null) return refused

  const resolved = await deps.resolve().catch(() => null)
  if (!resolved) return NO_EXECUTOR_ERROR
  const input = store().screenInput
  // 'picture': the list is left out even where the system has one.
  const hasList = input === 'picture' && resolved.sees ? false : await deps.treeAvailable().catch(() => false)
  const way = screenWay(input, resolved.sees, hasList)
  const withTree = way === 'list' || way === 'picture+list'
  const blind = way === 'list' || way === 'none'
  // From here on a model that is kept to the list is one that does not see.
  const executor = blind && resolved.sees ? { ...resolved, sees: false } : resolved
  if (blind && !withTree) return NO_EXECUTOR_ERROR

  const started = deps.now()
  const done: Done[] = []
  const steps: ComputerTaskStep[] = []
  store().setTask({ goal, maxSteps: TASK_MAX_STEPS, steps, phase: 'looking', modelLabel: executor.label, blind })
  if (blind) store().setNotice(BLIND_NOTICE(executor.label))
  // A model without sight says "I cannot find it" or asks for a window id,
  // and the chat model passes that on as if the user could answer it (seen
  // on the box with a canvas page, 07.10.2026). So the limit stands in the
  // first line of the result, where the chat model reads it first.
  const blindLimit = `${executor.label} cannot see images, so the task worked from the list of buttons and fields of the window only. A window that draws its own interface (a canvas, a game, a remote desktop) lists nothing to work with.`
  const blindAdvice = 'Tell the user this limit in plain words. Do not ask the user for window ids, coordinates or what the screen shows.'
  const finish = (head: string, tail: string[] = [], reached = false): string => blind && !reached
    ? report(`${head} ${blindLimit}`, goal, done, [...tail, blindAdvice])
    : report(head, goal, done, tail)
  let checks = 0
  /**
   * The summary of a check that found the goal reached, else null. Only after
   * an action that worked: before that there is nothing that could have
   * reached it.
   */
  const reachedNow = async (seenText: string, tree: string | null, frame: PendingFrame | null): Promise<string | null> => {
    if (checks >= MAX_GOAL_CHECKS || !done.some((step) => step.ok)) return null
    checks += 1
    setProgress([...steps], 'deciding')
    const screen = [observationText(seenText), tree].filter(Boolean).join('\n')
    const verdict = await deps.judge(executor, { goal, actions: done.map((step) => `${step.n}. ${sanitizeScreenText(step.outcome)}`), screen, frame }, signal).catch(() => null)
    return verdict?.reached ? verdict.summary || 'The screen shows that the goal is reached.' : null
  }
  const finishedByCheck = (summary: string): string =>
    finish('The screen task is finished.', [
      'The screen operator did not say that it was done. A check of the screen against the goal found it reached:',
      wrapScreenData([summary]),
    ], true)
  const ended = (end: StepEnd, text: string): string =>
    finish(`The screen task stopped. ${END_SENTENCE[end]} ${unfinished(done)}`, [
      text.replace(/^Error: /, ''),
      end === 'stopped' || end === 'cancelled' || end === 'off' || end === 'no_chat'
        ? 'Do not start it again unless the user asks. Tell the user that it was stopped and what was done so far. Do not say that the goal was reached.'
        : 'Do not try the same thing again. Tell the user that it did not finish and what was done so far, and ask what they want. Do not say that the goal was reached.',
    ])

  try {
    // The first look. It also lists the open windows, with their ids.
    let seen = await deps.step({ action: 'screenshot' }, run, signal)
    if (seen.end) return ended(seen.end, seen.text)
    if (seen.text.startsWith('Error:')) return finish('The screen task could not start.', [seen.text.replace(/^Error: /, '')])
    const first = startWindow(await deps.windows().catch(() => null), app, goal)
    if (first) {
      const brought = await deps.step({ action: 'focus_window', window_id: first.id }, run, signal)
      // "No" to the app or to the step ends the task. Anything else: the operator sees what is there.
      if (brought.end && brought.end !== 'blocked') return ended(brought.end, brought.text)
      if (frameIdInResult(brought.text) !== null) seen = brought
    }
    captionScreenShot(frameIdInResult(seen.text), 'Before the first step')

    let badAnswers = 0
    let correction: string | null = null
    let lastCall = ''
    let repeats = 0
    let blockedSteps = 0
    let panelMoves = 0
    const recent: string[] = []
    const notes: string[] = []

    while (true) {
      if (signal?.aborted) return ended('cancelled', 'The run was cancelled.')
      const note = deps.note?.() ?? null
      if (note) notes.push(note)
      const stopped = store().stopped
      if (stopped) return ended('stopped', stopped.message)
      if (done.length >= TASK_MAX_STEPS) {
        const lastId = frameIdInResult(seen.text)
        const atLimit = await reachedNow(seen.text, null, lastId === null || blind ? null : deps.takeFrame(lastId))
        if (atLimit !== null) return finishedByCheck(atLimit)
        return finish(`The screen task stopped after ${TASK_MAX_STEPS} actions without reaching the goal.`, ['Tell the user how far it got and ask how to go on.'])
      }
      if (deps.now() - started > TASK_TIME_LIMIT_MS) {
        return finish('The screen task stopped because it ran out of time.', ['Tell the user how far it got and ask how to go on.'])
      }

      const frameId = frameIdInResult(seen.text)
      // Taken also for a model that cannot see, so the picture does not wait for nobody.
      const taken = frameId === null ? null : deps.takeFrame(frameId)
      const frame = blind ? null : taken
      // The element list helps a model find small targets. Only for a window
      // the user approved: asking for the tree of any other app would put a
      // question on screen before the executor decided to go there.
      let tree: string | null = null
      if (withTree && computerFrontAllowed()) {
        const read = await deps.step({ action: 'read_tree' }, run, signal)
        if (read.end) return ended(read.end, read.text)
        if (!read.text.startsWith('Error:')) tree = read.text.length > MAX_TREE_CHARS ? `${read.text.slice(0, MAX_TREE_CHARS)}\n(list cut)` : read.text
      }

      // A model that works from the picture alone knows no element numbers.
      const listed = blind || tree !== null
      setProgress(steps, 'deciding')
      let answer: string
      try {
        answer = await deps.ask(
          executor,
          buildExecutorMessages({ executor, goal, app, done, observation: observationText(seen.text), tree, frame, correction, notes }),
          signal,
          listed,
        )
      } catch (error) {
        if (signal?.aborted) return ended('cancelled', 'The run was cancelled.')
        if (store().stopped) return ended('stopped', store().stopped!.message)
        log.warn('computer.task_executor_failed', { error: error instanceof Error ? error.name : 'unknown' })
        return finish(`The screen task stopped because the model that looks at the screen (${executor.label}) did not answer.`, [
          'Tell the user what happened and how far it got.',
        ])
      }

      const decision: ExecutorDecision = parseExecutorAnswer(executor.format, answer)
      if (decision.kind === 'invalid') {
        badAnswers += 1
        if (badAnswers >= MAX_BAD_ANSWERS) {
          return finish(`The screen task stopped because the model that looks at the screen (${executor.label}) did not name a usable action.`, [
            'Tell the user what happened and how far it got.',
          ])
        }
        correction = `Your last answer could not be used: ${decision.error} Answer with one JSON object in the format from your instructions.`
        continue
      }
      // A server that does not hold the model to the schema lets a number
      // through all the same. It names nothing, so no step is spent on it.
      if (!listed && decision.kind === 'act' && decision.calls.some((call) => call.element !== undefined)) {
        badAnswers += 1
        if (badAnswers >= MAX_BAD_ANSWERS) {
          return finish(`The screen task stopped because the model that looks at the screen (${executor.label}) did not name a usable action.`, [
            'Tell the user what happened and how far it got.',
          ])
        }
        correction = NO_ELEMENTS_CORRECTION
        continue
      }
      badAnswers = 0
      correction = null

      if (decision.kind === 'done') {
        return finish('The screen task is finished.', [
          'Report of the screen operator:',
          // The operator read the screen, so its words are screen data too.
          wrapScreenData([decision.summary]),
        ], true)
      }
      if (decision.kind === 'ask') {
        return finish('The screen task stopped because the screen operator needs an answer from the user.', [
          'Its question:',
          wrapScreenData([decision.question]),
          blind
            ? 'Pass the question on only if it is about what the user wants done. Then start a new screen task with the answer in the goal.'
            : 'Ask the user, then start a new screen task with the answer in the goal.',
        ])
      }

      const signature = JSON.stringify(decision.calls)
      repeats = signature === lastCall ? repeats + 1 : 1
      lastCall = signature
      // The operator asks for what it just did. Often that means it is done
      // and does not say so (seen with Holo 3.1 9B: it types the text and
      // then keeps clicking). One look at the goal settles it.
      if (repeats >= 2) {
        const summary = await reachedNow(seen.text, tree, frame)
        if (summary !== null) return finishedByCheck(summary)
      }
      if (repeats >= MAX_REPEATS) {
        return finish('The screen task stopped because the same action did not change anything.', ['Tell the user how far it got and ask how to go on.'])
      }
      recent.push(signature)
      if (recent.length > RETURN_WINDOW) recent.shift()
      if (recent.filter((s) => s === signature).length >= MAX_RETURNS) {
        const summary = await reachedNow(seen.text, tree, frame)
        if (summary !== null) return finishedByCheck(summary)
        return finish('The screen task stopped because the screen operator kept repeating the same actions.', [
          'The goal may already be reached. Tell the user what was done and what you cannot confirm, and ask how to go on.',
        ])
      }

      let fresh = false
      for (const call of decision.calls) {
        const n = done.length + 1
        const label = describeExecutorCall(call)
        steps.push({ n, label, ok: null })
        setProgress([...steps], 'acting')
        try { run?.onToolProgress?.(`Step ${n}: ${label}.`) } catch { /* a listener must not end the task */ }
        // The step is announced before it runs. A pause that comes first
        // holds it, and then it must not read as something LU did.
        const unwatch = deps.whenHeld?.(() => {
          steps[steps.length - 1] = { n, label: `${label} ${HELD_MARK}`, ok: null }
          setProgress([...steps], 'acting')
          try { run?.onToolProgress?.(`Step ${n} did not run: LU paused before it.`) } catch { /* a listener must not end the task */ }
        })
        let result: ComputerStep
        try {
          result = await deps.step(call, run, signal)
        } finally {
          unwatch?.()
        }
        if (result.again && !result.end && panelMoves < MAX_PANEL_MOVES) {
          // The panel was in the way and is not any more. Nothing was done
          // and nothing failed: the step leaves the list, the operator is
          // told, and asking for the same action again is not a repeat.
          panelMoves += 1
          steps.pop()
          setProgress([...steps], 'looking')
          lastCall = ''
          repeats = 0
          recent.pop()
          correction = PANEL_MOVED_CORRECTION
          const shown = frameIdInResult(result.text)
          fresh = shown !== null
          captionScreenShot(shown, 'After the panel moved out of the way')
          if (fresh) seen = result
          break
        }
        const ok = !result.end && !result.text.startsWith('Error:')
        steps[steps.length - 1] = { n, label, ok }
        setProgress([...steps], 'looking')
        // What was asked for and refused is part of the report.
        const offLimits = result.end === 'blocked'
        if (offLimits) blockedSteps += 1
        if (result.end && (!offLimits || blockedSteps >= MAX_BLOCKED)) return ended(result.end, result.text)
        const outcome = offLimits
          ? `${firstLine(result.text)} Nothing was done. Bring the window you need to the front with focus_window and an id from the list of open windows, or ask.`
          : firstLine(result.text)
        done.push({ n, label, ok, outcome, said: answer.length > 600 ? JSON.stringify({ thought: decision.thought }) : answer })
        const shown = frameIdInResult(result.text)
        fresh = shown !== null
        // The label says what was done without the typed text, so it can stand under the picture.
        captionScreenShot(shown, `Step ${n}: ${label}`)
        if (fresh) seen = result
        // A failed action (a stale picture, a bad coordinate) ends the pair:
        // the executor decides again on what is there now.
        if (!ok) break
      }
      if (!fresh) {
        // A wait, or an action that failed: there is no new picture yet.
        const again = await deps.step({ action: 'screenshot' }, run, signal)
        if (again.end) return ended(again.end, again.text)
        if (again.text.startsWith('Error:')) return finish('The screen task stopped because the screen could not be read.', [again.text.replace(/^Error: /, '')])
        seen = again
      }
    }
  } finally {
    store().setTask(null)
  }
}

/** The registered executor of `computer_task`. */
export function executeComputerTask(args: ToolArgs, run?: AgentRunContext, signal?: AbortSignal): Promise<string> {
  return runComputerTask(args, run, signal)
}
