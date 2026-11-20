import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * The load switch of an Ollama row in the chat model picker.
 *
 * Hand test on the Mac, 10.10.2026: the switch of a second model turned for as
 * long as anyone watched. The model that was loaded was still answering, so
 * Ollama could not make room, and the picker had no word for it and no way to
 * stop. "Unload all models" wrote "Unloaded" over a model that stayed loaded.
 *
 * What is driven here is the picker against an Ollama that behaves the same
 * way: it holds a load back until the app closes the request, and it says 200
 * to the unload of a busy model and keeps it. The rule under test is written
 * down in src/lib/ollama-switch.ts.
 *
 * Run: LU_E2E_PORT=5407 npx playwright test e2e/ollama-load-switch.spec.ts
 */

const BUSY = 'busy-model:27b'
const OTHER = 'other-model:9b'
const THIRD = 'third-model:4b'

async function boot(page: Page, ollama: Pick<TauriMockOptions, 'ollamaLoaded' | 'ollamaBusy' | 'ollamaHoldLoads'>) {
  const opts: TauriMockOptions = {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows',
    ollamaModels: [BUSY, OTHER, THIRD],
    ...ollama,
  }
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
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
  await expect(toggle(page, BUSY)).toBeVisible()
}

const generateBodies = (page: Page) =>
  page.evaluate(() => (window as unknown as { __E2E_OLLAMA_GENERATE__?: Array<Record<string, unknown>> }).__E2E_OLLAMA_GENERATE__ ?? [])

test('a load that Ollama holds back says why, can be cancelled where it was started, and locks nothing', async ({ page }) => {
  await boot(page, { ollamaLoaded: [BUSY], ollamaBusy: [BUSY], ollamaHoldLoads: true })
  await openPicker(page)

  await expect(toggle(page, BUSY)).toHaveAttribute('data-state', 'on')
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'off')

  // Load the second model. Ollama does not answer.
  await toggle(page, OTHER).click()
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'cancel')
  await expect(toggle(page, OTHER)).toHaveText(/Cancel/i)
  await expect(toggle(page, OTHER)).toBeEnabled()

  // The reason, in the picker, with the name of the model that is in the way.
  await expect(page.getByTestId('picker-ollama-waiting')).toHaveText(`Waiting for ${BUSY} to finish.`)
  // Nothing above or in the composer.
  await expect(page.locator('textarea').first()).not.toHaveValue(/Waiting/)

  // One Ollama switch at a time: the others are off while it runs.
  await expect(toggle(page, BUSY)).toBeDisabled()
  await expect(toggle(page, THIRD)).toBeDisabled()

  // The load went out with a context window, so the first message does not
  // load the model a second time.
  const load = (await generateBodies(page)).find((b) => b.model === OTHER)
  expect(typeof (load?.options as { num_ctx?: number } | undefined)?.num_ctx).toBe('number')

  // Picking a row is not held back by the pending load.
  await row(page, THIRD).click()
  await expect(trigger(page)).toContainText('third-model')

  // The load is still pending, and its switch is still its Cancel.
  await openPicker(page)
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'cancel')
  await toggle(page, OTHER).click()

  // Cancelled: every switch is back, the state is what Ollama reports, and
  // the person's own Cancel gets no error line.
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'off')
  await expect(toggle(page, OTHER)).toBeEnabled()
  await expect(toggle(page, BUSY)).toHaveAttribute('data-state', 'on')
  await expect(toggle(page, BUSY)).toBeEnabled()
  await expect(toggle(page, THIRD)).toBeEnabled()
  await expect(page.getByTestId('picker-ollama-waiting')).toHaveCount(0)
  await expect(page.getByTestId('picker-ollama-note')).toHaveCount(0)
})

test('"Unload all models" ends a pending load instead of waiting behind it', async ({ page }) => {
  await boot(page, { ollamaLoaded: [], ollamaHoldLoads: true })
  await openPicker(page)

  await toggle(page, OTHER).click()
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'cancel')

  const unloadAll = page.getByTestId('ollama-unload-all')
  await expect(unloadAll).toBeEnabled()
  await unloadAll.click()

  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'off')
  await expect(toggle(page, OTHER)).toBeEnabled()
  await expect(unloadAll).toHaveText('Unloaded')
})

test('unloading a model that is still answering does not say it is unloaded', async ({ page }) => {
  await boot(page, { ollamaLoaded: [BUSY, OTHER], ollamaBusy: [BUSY] })
  await openPicker(page)

  // The row switch.
  await toggle(page, BUSY).click()
  const note = page.getByTestId('picker-ollama-note')
  await expect(note).toContainText(`${BUSY} is still busy. It unloads when the running answer ends.`, { timeout: 15_000 })
  await expect(note).toHaveAttribute('data-tone', 'info')
  await expect(toggle(page, BUSY)).toHaveAttribute('data-state', 'on')

  // "Unload all models": the idle one goes, the busy one stays and is named.
  await note.getByRole('button', { name: 'Dismiss' }).click()
  await expect(note).toHaveCount(0)
  const unloadAll = page.getByTestId('ollama-unload-all')
  await unloadAll.click()
  await expect(note).toContainText(`${BUSY} is still busy.`, { timeout: 15_000 })
  await expect(unloadAll).toHaveText('Unload all models')
  await expect(toggle(page, BUSY)).toHaveAttribute('data-state', 'on')
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'off')
})

test('control: an idle model really unloads, and then it says so', async ({ page }) => {
  await boot(page, { ollamaLoaded: [BUSY, OTHER] })
  await openPicker(page)

  await toggle(page, OTHER).click()
  await expect(toggle(page, OTHER)).toHaveAttribute('data-state', 'off')
  await expect(page.getByTestId('picker-ollama-note')).toHaveCount(0)

  const unloadAll = page.getByTestId('ollama-unload-all')
  await unloadAll.click()
  await expect(unloadAll).toHaveText('Unloaded')
  await expect(toggle(page, BUSY)).toHaveAttribute('data-state', 'off')
  await expect(page.getByTestId('picker-ollama-note')).toHaveCount(0)
})
