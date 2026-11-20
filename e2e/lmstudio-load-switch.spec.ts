import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * The load switch of an LM Studio row in the chat model picker.
 *
 * LM Studio loads through its `lms` command, which returns only when the
 * model is in memory. The app waited with it: no limit, no way to stop, and
 * every row of the picker off for as long as it lasted. The Ollama switch got
 * an end on 10.10.2026 (e2e/ollama-load-switch.spec.ts); this is the same
 * rule for LM Studio, written down in src/lib/lmstudio-switch.ts.
 *
 * What is driven here is the picker against a stand-in for the bridge: a load
 * that never answers until the app cancels it, a load the command refuses with
 * a sentence, and an unload that is answered while the model stays listed.
 *
 * And what a real LM Studio was seen to do with a killed `lms load` on
 * 11.10.2026: finish the load on its own and keep the model. The stand-in
 * does the same (`lmStudioFinishesLoadsAfterMs`), and the row has to say
 * "Cancelling" until the app has unloaded what arrived
 * (src/lib/lmstudio-ended-loads.ts). No LM Studio runs here.
 *
 * Run: LU_E2E_PORT=5402 npx playwright test e2e/lmstudio-load-switch.spec.ts
 * Pictures: add LU_E2E_SHOT_DIR=/path/to/folder
 */

const FIRST = 'first-model-7b'
const SECOND = 'second-model-9b'
const THIRD = 'third-model-4b'

type LmStudio = Pick<TauriMockOptions, 'lmStudioLoaded' | 'lmStudioHoldLoads' | 'lmStudioLoadRefusal' | 'lmStudioKeepsLoaded' | 'lmStudioFinishesLoadsAfterMs' | 'lmStudioUnloadTakesMs' | 'lmStudioUnloadEndsLoads'>

const SHOTS = process.env.LU_E2E_SHOT_DIR
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function boot(page: Page, lmStudio: LmStudio) {
  const opts: TauriMockOptions = {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows',
    lmStudioModels: [FIRST, SECOND, THIRD],
    ...lmStudio,
  }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'lu-providers',
      JSON.stringify({
        state: {
          hideBackendSelector: true,
          providers: {
            ollama: { id: 'ollama', name: 'Ollama', enabled: false, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true },
            openai: { id: 'openai', name: 'LM Studio', enabled: true, baseUrl: 'http://localhost:1234/v1', apiKey: '', isLocal: true, managed: false },
            anthropic: { id: 'anthropic', name: 'Anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKey: '', isLocal: false },
            'lu-cloud': { id: 'lu-cloud', name: 'LU Cloud', enabled: false, baseUrl: 'https://lu-labs.ai/api/inference/v1', apiKey: '', isLocal: false },
          },
        },
        version: 1,
      }),
    )
  })
  await page.goto('/')
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')
/** The row of a model: the element that is a button by role and carries the name. */
const row = (page: Page, name: string) => menu(page).getByRole('button').filter({ hasText: name }).filter({ has: page.getByTestId('load-toggle') })
const toggle = (page: Page, name: string) => row(page, name).getByTestId('load-toggle')

async function openPicker(page: Page) {
  await expect(trigger(page)).toBeVisible({ timeout: 30_000 })
  await trigger(page).click()
  await expect(menu(page)).toBeVisible()
  await expect(toggle(page, FIRST)).toBeVisible()
}

const bucket = <T,>(page: Page, name: string) =>
  page.evaluate((key) => (window as unknown as Record<string, T[] | undefined>)[key] ?? [], name)
const loads = (page: Page) => bucket<{ model: string; contextLength: number | null; timeoutMs: number; callId: string }>(page, '__E2E_LMSTUDIO_LOADS__')
const cancels = (page: Page) => bucket<{ callId: string }>(page, '__E2E_LMSTUDIO_CANCELS__')
const unloads = (page: Page) => bucket<{ model: string }>(page, '__E2E_LMSTUDIO_UNLOADS__')

// What the app sends for a cancelled load of SECOND: one unload as soon as
// LM Studio reports the load, and, when that changed nothing, one more once
// the model has arrived.
const EARLY = [{ model: SECOND }]
const EARLY_AND_LATE = [{ model: SECOND }, { model: SECOND }]

/** Every state the switch of a row shows from now on, in order, without repeats. */
async function recordStates(page: Page, name: string) {
  const handle = await toggle(page, name).elementHandle()
  await page.evaluate((el) => {
    const seen: string[] = []
    ;(window as unknown as Record<string, string[]>).__E2E_SWITCH_STATES__ = seen
    const note = () => {
      const state = el?.getAttribute('data-state') ?? ''
      if (seen[seen.length - 1] !== state) seen.push(state)
    }
    note()
    new MutationObserver(note).observe(el as Element, { attributes: true, attributeFilter: ['data-state'] })
  }, handle)
}
const recordedStates = (page: Page) => bucket<string>(page, '__E2E_SWITCH_STATES__')

test('a load that never answers can be cancelled where it was started', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [FIRST], lmStudioHoldLoads: true })
  await openPicker(page)

  await expect(toggle(page, FIRST)).toHaveAttribute('data-state', 'on')
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')

  // Load the second model. The command does not come back.
  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await expect(toggle(page, SECOND)).toHaveText(/Cancel/i)
  await expect(toggle(page, SECOND)).toBeEnabled()

  // One LM Studio switch at a time: the others are off while it runs.
  await expect(toggle(page, FIRST)).toBeDisabled()
  await expect(toggle(page, THIRD)).toBeDisabled()

  // The bridge was handed a limit of its own and the handle the cancel uses.
  const [load] = await loads(page)
  expect(load.model).toBe(SECOND)
  expect(load.timeoutMs).toBeGreaterThan(0)
  expect(typeof load.callId).toBe('string')

  // A pick of another LM Studio row is itself a load, so it is refused, and
  // it says why instead of doing nothing. Forced, because the row is marked
  // as switched off and a person can click it all the same.
  await row(page, THIRD).click({ force: true })
  await expect(page.getByTestId('model-picker-error')).toContainText('LM Studio is still loading a model')
  // Nothing in the composer.
  await expect(page.locator('textarea').first()).toHaveValue('')

  await toggle(page, SECOND).click()

  // Cancelled: the bridge was told to end exactly this load, and the other
  // switches are back at once. The row itself is not called off before LM
  // Studio was seen without the model for a few looks.
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')
  await expect(toggle(page, FIRST)).toHaveAttribute('data-state', 'on')
  await expect(toggle(page, FIRST)).toBeEnabled()
  await expect(toggle(page, THIRD)).toBeEnabled()
  expect(await cancels(page)).toEqual([{ callId: load.callId }])

  // LM Studio dropped this load, so nothing is unloaded, the state is what
  // LM Studio lists, and the person's own Cancel gets no error line.
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  await expect(toggle(page, SECOND)).toBeEnabled()
  expect(await unloads(page)).toEqual([])
  await expect(page.getByTestId('picker-lmstudio-note')).toHaveCount(0)
})

test('a cancelled load is ended by an unload at once when LM Studio takes it, and the row is off within a moment', async ({ page }) => {
  // LM Studio 0.4.12 as measured: the load goes on without its command, and
  // an unload of the model ends it in half a second.
  await boot(page, { lmStudioLoaded: [FIRST], lmStudioFinishesLoadsAfterMs: 40_000, lmStudioUnloadEndsLoads: true, lmStudioUnloadTakesMs: 500 })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await recordStates(page, SECOND)
  await page.waitForTimeout(1_000)
  await toggle(page, SECOND).click()

  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')
  await shot(page, '6-cancelling-while-the-early-unload-is-out')
  // Far below the 40 s the load would have taken.
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off', { timeout: 4_000 })
  expect(await unloads(page)).toEqual(EARLY)
  await shot(page, '7-off-after-the-early-unload')

  await page.waitForTimeout(4_000)
  expect(await recordedStates(page)).toEqual(['cancel', 'cancelling', 'off'])
  expect(await unloads(page)).toEqual(EARLY)
  await expect(toggle(page, FIRST)).toHaveAttribute('data-state', 'on')
})

test('a cancelled load LM Studio finishes anyway is unloaded, and the row says Cancelling until it is gone', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [FIRST], lmStudioFinishesLoadsAfterMs: 6_000 })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await recordStates(page, SECOND)
  await shot(page, '1-loading-cancel-offered')
  await toggle(page, SECOND).click()

  // The command is gone, LM Studio is still loading and does not take the
  // early unload: not "Off".
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')
  await expect(toggle(page, SECOND)).toHaveText(/Cancelling/i)
  await expect(toggle(page, SECOND)).toBeDisabled()
  await expect(toggle(page, SECOND)).toHaveAttribute('title', /Cancelling/)
  // Nothing else is held up by it.
  await expect(toggle(page, FIRST)).toBeEnabled()
  await expect(toggle(page, THIRD)).toBeEnabled()
  expect(await unloads(page)).toEqual(EARLY)
  await shot(page, '2-cancelling-while-lm-studio-still-loads')

  // LM Studio reports the model loaded after 6 s. The app unloads it.
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  await expect(toggle(page, SECOND)).toBeEnabled()
  expect(await unloads(page)).toEqual(EARLY_AND_LATE)
  // Never "On" on the way, although LM Studio listed it for a moment.
  expect(await recordedStates(page)).toEqual(['cancel', 'cancelling', 'off'])
  await expect(toggle(page, FIRST)).toHaveAttribute('data-state', 'on')
  await expect(page.getByTestId('picker-lmstudio-note')).toHaveCount(0)
  await shot(page, '3-off-after-the-unload')

  // And it stays off: this is where the hand test found "On" a minute later.
  await page.waitForTimeout(8_000)
  await page.keyboard.press('Escape')
  await openPicker(page)
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  expect(await unloads(page)).toEqual(EARLY_AND_LATE)
  await shot(page, '4-still-off-when-the-picker-is-opened-again')
})

test('the row is never On after a cancel, also when the picker read the list in the second the model was loaded', async ({ page }) => {
  // Hand test, 11.10.2026: the model was loaded for about a second before the
  // app's unload took it away. A read of the loaded list by the open picker
  // fell into that second in 3 of 4 runs, and the row showed a green "On"
  // for 0.87 to 0.98 s after "Cancelling". Here the unload takes 2.5 s, so a
  // read of the picker (one every 1.5 s) falls into it every time.
  await boot(page, { lmStudioLoaded: [], lmStudioFinishesLoadsAfterMs: 3_000, lmStudioUnloadTakesMs: 2_500 })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await recordStates(page, SECOND)
  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')

  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  await shot(page, '5-off-straight-after-cancelling')
  // Two more reads of the picker, so a late "On" would be on the record too.
  await page.waitForTimeout(3_500)
  expect(await recordedStates(page)).toEqual(['cancel', 'cancelling', 'off'])
  expect(await unloads(page)).toEqual(EARLY_AND_LATE)
})

test('closing the picker does not stop the unload of a cancelled load', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [], lmStudioFinishesLoadsAfterMs: 5_000 })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()

  await expect.poll(() => unloads(page)).toEqual(EARLY_AND_LATE)
  await openPicker(page)
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
})

test('picking the model again while it is cancelling keeps it, without a second load', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [], lmStudioFinishesLoadsAfterMs: 6_000 })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')

  // The pick is a load of the same model: the row is loading again, with its
  // Cancel, and the load LM Studio is still on is the one that is waited for.
  await row(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await expect(menu(page)).toBeHidden()
  await expect(trigger(page)).toContainText('second-model')
  expect((await loads(page)).map((l) => l.model)).toEqual([SECOND])

  // Wanted now, so never unloaded later: the one unload of it is the early
  // one from before the click. (The model the chat was on before is unloaded
  // by the pick itself, as on every pick.)
  await page.waitForTimeout(5_000)
  expect((await unloads(page)).filter((u) => u.model === SECOND)).toEqual(EARLY)
  await openPicker(page)
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'on')
})

test('another model can be loaded while one is cancelling: it stays, the cancelled one goes', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [], lmStudioFinishesLoadsAfterMs: 5_000 })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')

  await toggle(page, THIRD).click()
  await expect(toggle(page, THIRD)).toHaveAttribute('data-state', 'cancel')
  // The cancelling row is not the "off" of a row that waits for another load.
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')

  await expect(toggle(page, THIRD)).toHaveAttribute('data-state', 'on')
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  expect(await unloads(page)).toEqual(EARLY_AND_LATE)
})

test('a pick that loads the model is cancelled on the switch of its row and picks nothing', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [FIRST], lmStudioHoldLoads: true })
  await openPicker(page)
  const before = await trigger(page).textContent()

  await row(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  await expect(toggle(page, SECOND)).toBeEnabled()
  await expect(toggle(page, FIRST)).toBeDisabled()

  await toggle(page, SECOND).click()

  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')
  await expect(toggle(page, FIRST)).toBeEnabled()
  expect(await cancels(page)).toHaveLength(1)
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  // The menu stays open, no error is shown, and the pick was not made.
  await expect(menu(page)).toBeVisible()
  await expect(page.getByTestId('model-picker-error')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(trigger(page)).toHaveText(before ?? '')
})

test('a load ends at its limit, is stopped at the bridge, and the picker says so', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [], lmStudioHoldLoads: true })
  await openPicker(page)
  // Installed after the app is up: waiting for the picker polls on the page's clock.
  await page.clock.install()

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')

  // Not before the limit.
  await page.clock.fastForward(299_000)
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancel')
  expect(await cancels(page)).toHaveLength(0)

  await page.clock.fastForward(2_000)

  const note = page.getByTestId('picker-lmstudio-note')
  await expect(note).toContainText(`Loading ${SECOND} took too long and was stopped. Try again.`)
  await expect(note).toHaveAttribute('data-tone', 'error')
  expect(await cancels(page)).toHaveLength(1)
  // Stopped at the limit is ended like a Cancel: LM Studio is watched until
  // the model is seen to be gone.
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'cancelling')
  await expect(toggle(page, FIRST)).toBeEnabled()
  await page.clock.runFor(10_000)
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  await expect(toggle(page, SECOND)).toBeEnabled()

  await note.getByRole('button', { name: 'Dismiss' }).click()
  await expect(note).toHaveCount(0)
})

test('a load LM Studio refuses says the reason the command gave', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [], lmStudioLoadRefusal: 'Insufficient system resources.' })
  await openPicker(page)

  await toggle(page, SECOND).click()
  const note = page.getByTestId('picker-lmstudio-note')
  await expect(note).toHaveText(`Could not load ${SECOND}. Insufficient system resources.`)
  await expect(note).toHaveAttribute('data-tone', 'error')
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')

  // The same reason when a pick ran into it, and the pick is not made.
  await note.getByRole('button', { name: 'Dismiss' }).click()
  await row(page, THIRD).click()
  await expect(page.getByTestId('model-picker-error')).toHaveText(`Could not load ${THIRD}. Insufficient system resources.`)
  await expect(menu(page)).toBeVisible()
})

test('an unload that is answered while the model stays listed is not called unloaded', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [FIRST, SECOND], lmStudioKeepsLoaded: [FIRST] })
  await openPicker(page)

  await toggle(page, FIRST).click()
  const note = page.getByTestId('picker-lmstudio-note')
  await expect(note).toContainText(`Could not unload ${FIRST}. LM Studio still lists it as loaded.`, { timeout: 15_000 })
  await expect(toggle(page, FIRST)).toHaveAttribute('data-state', 'on')

  // Control: a model that really goes is off afterwards, without a sentence.
  await note.getByRole('button', { name: 'Dismiss' }).click()
  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'off')
  await expect(note).toHaveCount(0)
})

test('control: a load that goes through turns the switch on, and a pick of it is made', async ({ page }) => {
  await boot(page, { lmStudioLoaded: [] })
  await openPicker(page)

  await toggle(page, SECOND).click()
  await expect(toggle(page, SECOND)).toHaveAttribute('data-state', 'on')
  await expect(page.getByTestId('picker-lmstudio-note')).toHaveCount(0)

  await row(page, THIRD).click()
  await expect(menu(page)).toBeHidden()
  await expect(trigger(page)).toContainText('third-model')
  expect((await loads(page)).map((l) => l.model)).toEqual([SECOND, THIRD])
})
