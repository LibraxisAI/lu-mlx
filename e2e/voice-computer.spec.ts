import { test, expect, type Locator, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules } from './support/ui'

/**
 * The Voice surface and computer control on one page, without a voice loop:
 * the screen calls a voice session would make are made by the spec, as the
 * standing run of a voice session, through the app's own code. Rust is the
 * mock; no mouse, keyboard or screen is touched.
 *
 * Held here: the question of computer control above the controls of Voice
 * does not cover the row of switches next to the title (also at 900 x 600),
 * the bar of computer control does not cover it either, a spoken "stop"
 * pauses, the paused view shows a thought of the session folded, and both
 * answers of the paused view work from Voice.
 *
 * What a real voice session does with all this is voice-screen-task-live.spec.ts.
 */

const SHOTS = process.env.LU_VOICE_SHOTS

/** The modules of the app this spec calls into, loaded once per page (see appModules). */
const COMPUTER_USE = '/src/api/computer-use.ts'
const VOICE_COMPUTER = '/src/api/voice-computer.ts'
const VOICE_SESSION_STORE = '/src/stores/voiceSessionStore.ts'
const COMPUTER_STORE = '/src/stores/computerStore.ts'
type App = Record<string, Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any

interface Box { x: number; y: number; width: number; height: number }

async function boot(page: Page, size: { width: number; height: number }, computer: Record<string, unknown> = {}, allowed = false) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
  })
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows' as const,
    // The voice engine is in memory, so the light switch stands in the row too.
    voiceLoop: { installed: true, running: true, session: { port: 9, token: 'e2e-launch-token'.padEnd(64, '0') } },
    // The window stays a window, as on Linux: the question stands above the controls of Voice.
    computer: { shrinks: false, ...computer },
  })
  await seedOnboardingDone(page)
  await page.addInitScript((notepadAllowed) => {
    localStorage.setItem('locally-uncensored-voice', JSON.stringify({
      state: { loopAgent: true, loopScope: 'computer', loopComputerConfirmed: true }, version: 0,
    }))
    localStorage.setItem('locally-uncensored-computer', JSON.stringify({
      state: { enabled: true, alwaysAllowed: notepadAllowed ? [{ key: 'notepad.exe', name: 'Notepad' }] : [], executorModel: null }, version: 1,
    }))
  }, allowed)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()
  // The size the user drags the window to once Voice is open.
  await page.setViewportSize(size)
  await appModules(page, [COMPUTER_USE, VOICE_COMPUTER, VOICE_SESSION_STORE, COMPUTER_STORE])
}

/** One screen call of a voice session: the standing run from Start to Stop. Not awaited: it may wait for the user. */
const screenCall = (page: Page, args: Record<string, unknown>) => page.evaluate(({ callArgs, path }) => {
  const w = window as unknown as { __APP__: App; __VOICE_RUN__?: unknown; __SCREEN_RESULTS__?: string[] }
  w.__VOICE_RUN__ ??= { token: 'voice-e2e', standing: true, startedAt: Date.now() }
  w.__SCREEN_RESULTS__ ??= []
  void w.__APP__[path].executeComputerUse(callArgs, w.__VOICE_RUN__).then((text: string) => { w.__SCREEN_RESULTS__!.push(text) })
}, { callArgs: args, path: COMPUTER_USE })
const results = (page: Page) => page.evaluate(() => (window as unknown as { __SCREEN_RESULTS__?: string[] }).__SCREEN_RESULTS__ ?? [])
const fired = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_COMPUTER_FIRED__?: unknown[] }).__E2E_COMPUTER_FIRED__ ?? [])
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __E2E_COMPUTER_CALLS__?: { cmd: string }[] }).__E2E_COMPUTER_CALLS__ ?? []).map((call) => call.cmd))
/** The voice loop tells the app that "yes" or "no" was said to the question that is open. */
const sayAnswer = (page: Page, answer: 'yes' | 'no') => page.evaluate(({ computer, voice, word }) => {
  const app = (window as unknown as { __APP__: App }).__APP__
  app[voice].voiceAnswered(app[computer].useComputerStore.getState().prompt?.id, word)
}, { computer: COMPUTER_STORE, voice: VOICE_COMPUTER, word: answer })
/** The voice loop tells the app that "stop" or "wait" was said. */
const sayStop = (page: Page) => page.evaluate((path) => {
  (window as unknown as { __APP__: App }).__APP__[path].voiceSaidStop()
}, VOICE_COMPUTER)

const box = async (locator: Locator): Promise<Box> => {
  await expect(locator).toBeVisible()
  return (await locator.boundingBox())!
}
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const inside = (a: Box, size: { width: number; height: number }) => a.x >= 0 && a.y >= 0 && a.x + a.width <= size.width + 0.5 && a.y + a.height <= size.height + 0.5

/** A live session with words in the transcript and a screen task under way, as the voice loop and the task report them. */
const midTask = (page: Page) => page.evaluate(({ session, computer }) => {
  const app = (window as unknown as { __APP__: App }).__APP__
  const { useComputerStore } = app[computer]
  const send = app[session].useVoiceSessionStore.getState().dispatch
  send({ type: 'start', at: Date.now(), muted: false })
  send({ type: 'brain', modelLabel: 'Qwen3 4B', notice: null })
  send({ type: 'ready' })
  send({ type: 'user-text', text: 'Click the Save button in the editor on my screen.', final: true })
  send({ type: 'bot-text', text: 'I will save the note for you.' })
  send({ type: 'bot-silent' })
  send({ type: 'tool-running', id: 'call-1', name: 'computer_task', args: { goal: 'Click the Save button in the editor' } })
  useComputerStore.getState().setTask({
    goal: 'Click the Save button in the editor', maxSteps: 25, phase: 'acting', modelLabel: 'Qwen3 4B',
    steps: [{ n: 1, label: 'Click at 203, 235', ok: null }],
  })
}, { session: VOICE_SESSION_STORE, computer: COMPUTER_STORE })

for (const size of [{ width: 900, height: 600 }, { width: 1280, height: 800 }]) {
  for (const when of ['before the first words', 'in the middle of a task'] as const) {
    test(`${size.width} x ${size.height}, ${when}: the question above the controls of Voice, the bar of computer control and the row of switches do not cover each other`, async ({ page }) => {
      await boot(page, size)
      const view = page.getByTestId('voice-view')
      const row = view.getByRole('toolbar', { name: 'Voice controls' })
      const switches = [
        view.getByTestId('voice-unload'),
        row.getByRole('button', { name: 'Voice settings' }),
        row.getByRole('button', { name: 'Agent' }),
        row.getByTestId('voice-scope'),
        row.getByRole('button', { name: 'Thinking' }),
      ]
      await expect(row.getByTestId('voice-scope')).toHaveAttribute('data-scope', 'computer')
      // The tallest bar: with the goal and the step of a running task in it.
      if (when === 'in the middle of a task') await midTask(page)

      // A look, then a click in an app the user has not approved: the largest question.
      await screenCall(page, { action: 'screenshot' })
      await expect.poll(() => results(page)).toHaveLength(1)
      await screenCall(page, { action: 'click', x: 500, y: 500 })
      const question = view.getByRole('group', { name: 'Allow LU to control Notepad?' })
      await expect(question).toBeVisible()
      // One question, and it is in Voice: no dialog at the top, no second copy at the bottom edge.
      await expect(page.getByTestId('computer-question')).toHaveCount(1)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const bar = page.getByTestId('computer-control-bar')
      await expect(bar).toBeVisible()
      if (when === 'in the middle of a task') await expect(bar.getByTestId('computer-task-progress')).toBeVisible()
      await expect(view.getByTestId('voice-status')).toBeVisible()

      const check = async (what: Locator) => {
        const q = await box(what)
        const barBox = await box(bar)
        expect(inside(q, size), 'the question is inside the window').toBe(true)
        for (const control of switches) {
          const c = await box(control)
          expect(overlap(q, c), 'the question covers a switch').toBe(false)
          expect(overlap(barBox, c), 'the bar of computer control covers a switch').toBe(false)
          expect(inside(c, size)).toBe(true)
        }
        expect(overlap(q, barBox), 'the bar covers the question').toBe(false)
        // The controls of the session stay below the question and in the window.
        for (const control of await view.getByTestId('voice-session').getByRole('button', { name: /^(Start voice|Mute microphone|Stop voice)$/ }).all()) {
          const c = await box(control)
          expect(c.y).toBeGreaterThanOrEqual(q.y + q.height)
          expect(inside(c, size)).toBe(true)
        }
        // Every button of the question can be reached.
        for (const button of await what.getByRole('button').all()) expect(inside(await box(button), size)).toBe(true)
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/a21-question-above-voice-${size.width}x${size.height}-${when.replace(/ /g, '-')}.png` })
      await check(question)

      // The switches still work while the question is open: the menu opens over it and closes again.
      await row.getByTestId('voice-scope').click()
      await expect(view.getByRole('menu', { name: 'Where it may work' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(view.getByRole('menu', { name: 'Where it may work' })).toHaveCount(0)
      await expect(question).toBeVisible()

      // Answered: the session is supervised, so the action itself is asked next.
      await question.getByRole('button', { name: 'Allow for this session' }).click()
      const confirm = view.getByRole('group', { name: 'Confirm this action' })
      await check(confirm)
      await confirm.getByRole('button', { name: 'Confirm' }).click()
      await expect.poll(() => fired(page)).toHaveLength(1)
      await expect(page.getByTestId('computer-question')).toHaveCount(0)
    })
  }
}

test('a supervised voice session: a spoken yes confirms an ordinary action, the click on "Send" shows its reason and takes the click only', async ({ page }) => {
  // Windows run A22, 11.3: the click on "Send" was asked without a reason and a spoken yes confirmed it.
  await boot(page, { width: 1280, height: 800 }, { sensitive: true }, true)
  const view = page.getByTestId('voice-view')
  await screenCall(page, { action: 'screenshot' })
  await expect.poll(() => results(page)).toHaveLength(1)

  // An ordinary action: the voice may answer it.
  await screenCall(page, { action: 'key', keys: 'tab' })
  const confirm = view.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText('Supervised: you confirm every action.')
  await expect(confirm.getByTestId('computer-confirm-reason')).toHaveCount(0)
  await sayAnswer(page, 'yes')
  await expect.poll(() => fired(page)).toHaveLength(1)

  // The click on "Send": the reason in red, and "yes" changes nothing.
  await screenCall(page, { action: 'click', x: 500, y: 500 })
  await expect(confirm.getByTestId('computer-confirm-reason')).toContainText('The click target "Send" contains "send"')
  await sayAnswer(page, 'yes')
  await sayAnswer(page, 'yes')
  await expect(confirm.getByTestId('computer-confirm-reason')).toBeVisible()
  expect(await fired(page)).toHaveLength(1)
  // The click is the answer.
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(2)

  // A spoken no declines a sensitive action: declining is always safe.
  await screenCall(page, { action: 'click', x: 500, y: 500 })
  await expect(confirm.getByTestId('computer-confirm-reason')).toBeVisible()
  await sayAnswer(page, 'no')
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  expect(await fired(page)).toHaveLength(2)
})

test('"stop" by voice pauses: the paused view covers Voice, shows a thought of the session folded, and "Let it continue" goes on', async ({ page }) => {
  await boot(page, { width: 1280, height: 800 })
  const view = page.getByTestId('voice-view')
  // What the session thought and said before the task, as the voice loop reports it.
  await page.evaluate((path) => {
    const send = (window as unknown as { __APP__: App }).__APP__[path].useVoiceSessionStore.getState().dispatch
    send({ type: 'start', at: Date.now(), muted: false })
    send({ type: 'brain', modelLabel: 'Qwen3 4B', notice: null })
    send({ type: 'ready' })
    send({ type: 'user-text', text: 'Click the Save button on my screen.', final: true })
    send({ type: 'thought-text', text: 'The user wants the note saved. The Save button is in the toolbar of the editor.' })
    send({ type: 'thought-end', secs: 2.2 })
    send({ type: 'tool-running', id: 'call-1', name: 'computer_task', args: { goal: 'Click the Save button' } })
  }, VOICE_SESSION_STORE)
  await screenCall(page, { action: 'screenshot' })
  await expect.poll(() => results(page)).toHaveLength(1)

  await sayStop(page)
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible()
  await expect(paused).toContainText('You asked LU to wait. LU does nothing until you choose.')
  await expect(paused.getByRole('button', { name: 'Take over' })).toBeFocused()
  expect(await calls(page)).toContain('computer_pause')
  // Paused, not stopped.
  await expect(page.getByTestId('computer-note')).toHaveCount(0)
  // The session behind the paused view is still there, and says so.
  await expect(view).toBeAttached()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'live')
  await expect(view.getByTestId('voice-status')).toHaveText('Paused')

  // The thought of the session: the chat's folded block, not its words.
  const activity = paused.getByTestId('computer-activity')
  const thought = activity.locator('[data-role="thought"]')
  const header = thought.getByRole('button', { name: 'Toggle thinking details' })
  await expect(header).toHaveText('Thought for 2 s')
  await expect(paused).not.toContainText('The Save button is in the toolbar')
  await expect(paused).not.toContainText('<think>')
  await expect(activity.locator('[data-tool="computer_task"]')).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/a21-paused-by-voice-thought-folded.png` })
  await header.click()
  await expect(thought).toContainText('The Save button is in the toolbar of the editor.')

  // A step that comes now waits, and nothing runs.
  await screenCall(page, { action: 'screenshot' })
  await page.waitForTimeout(600)
  expect(await results(page)).toHaveLength(1)

  await paused.getByRole('button', { name: 'Let it continue' }).click()
  await expect(paused).toHaveCount(0)
  await expect.poll(() => results(page)).toHaveLength(2)
  await expect(view.getByTestId('voice-status')).not.toHaveText('Paused')
  expect((await calls(page)).filter((cmd) => cmd === 'computer_stop')).toHaveLength(0)
})

test('"wait" by voice while a question is open: paused first, the question comes back after "Let it continue", and "Take over" ends the task', async ({ page }) => {
  await boot(page, { width: 900, height: 600 })
  const view = page.getByTestId('voice-view')
  await screenCall(page, { action: 'screenshot' })
  await expect.poll(() => results(page)).toHaveLength(1)
  await screenCall(page, { action: 'click', x: 500, y: 500 })
  const question = view.getByRole('group', { name: 'Allow LU to control Notepad?' })
  await expect(question).toBeVisible()

  await sayStop(page)
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toBeVisible()
  // The paused view is inside the window and its buttons can be reached at this size.
  for (const name of ['Take over', 'Let it continue']) {
    const button = (await paused.getByRole('button', { name }).boundingBox())!
    expect(button.y + button.height).toBeLessThanOrEqual(600)
    expect(button.x + button.width).toBeLessThanOrEqual(900)
  }
  await paused.getByRole('button', { name: 'Let it continue' }).click()
  await expect(paused).toHaveCount(0)
  // The question was not answered by the pause.
  await expect(question).toBeVisible()
  expect(await fired(page)).toEqual([])

  await sayStop(page)
  await expect(paused).toBeVisible()
  await paused.getByRole('button', { name: 'Take over' }).click()
  await expect(paused).toHaveCount(0)
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  await expect(page.getByTestId('computer-note')).toContainText('Computer control stopped.')
  await expect.poll(() => results(page)).toHaveLength(2)
  expect((await results(page))[1]).toMatch(/^Error: /)
  expect(await fired(page)).toEqual([])
  // Voice is still the surface, with its switches.
  await expect(view.getByRole('toolbar', { name: 'Voice controls' })).toBeVisible()
})

test('on a window that shrinks, the pause by voice is the paused view in the panel, and the window is back after "Take over"', async ({ page }) => {
  // Notepad is always allowed and the session is autonomous: nothing is asked, LU is the panel at work.
  await boot(page, { width: 1280, height: 800 }, { shrinks: true, actionMs: 1500 }, true)
  await page.evaluate((path) => {
    (window as unknown as { __APP__: App }).__APP__[path].useComputerStore.getState().setAutonomous(true)
  }, COMPUTER_STORE)
  await screenCall(page, { action: 'screenshot' })
  await expect.poll(() => results(page)).toHaveLength(1)
  await screenCall(page, { action: 'click', x: 500, y: 500 })
  const surface = page.getByTestId('computer-surface')
  await expect(surface).toHaveAttribute('data-surface', 'panel')
  await expect(page.getByTestId('computer-shortcuts')).toContainText('Pause Ctrl+Alt+Space')
  const box = await surface.boundingBox()

  await sayStop(page)
  const paused = page.getByRole('alertdialog', { name: 'LU has paused' })
  await expect(paused).toContainText('You asked LU to wait.')
  // The same panel, where and as large as it was.
  await expect(surface).toHaveAttribute('data-surface', 'panel')
  expect(await surface.boundingBox()).toEqual(box)
  await paused.getByRole('button', { name: 'Take over' }).click()
  await expect(surface).toHaveCount(0)
  await expect(page.locator('html')).not.toHaveAttribute('data-computer-surface', /panel|pause/)
  await expect(page.getByTestId('voice-view')).toBeVisible()
  await expect(page.locator('#root')).toHaveCSS('visibility', 'visible')
})
