import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * Picking another model while an answer is still being written takes the
 * built-in engine away from under it: the engine restarts with the new file
 * and the stream of the old answer closes. The answer used to end as
 * "Connection dropped before the end", as if the network had failed, and the
 * pick the person had just made was not named.
 *
 * Nobody is asked and the pick is not held back. The answer that was cut
 * says why, in the place the cut-off marker stands, and nothing appears in
 * or over the composer.
 */

const FIRST = 'qwen2.5-7b-instruct-q4_k_m'
const SECOND = 'gemma-3-12b-it-q4_k_m'
const REPLY = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: REPLY,
    modelName: FIRST,
    bundledModels: [{ name: FIRST }, { name: SECOND }],
    replyChunks: 60,
    replyChunkDelayMs: 150,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)
}

function engineCalls(page: Page) {
  return page.evaluate(() => ((window as unknown as { __E2E_ENGINE_CALLS__?: { cmd: string; modelPath: string }[] }).__E2E_ENGINE_CALLS__ ?? [])
    .filter((c) => c.cmd === 'swap_bundled_model').map((c) => c.modelPath))
}

test('an answer cut by a model switch says that the switch stopped it', async ({ page }) => {
  await boot(page)
  const composer = page.locator('textarea').first()
  await composer.fill('Tell me a long story')
  await page.getByRole('button', { name: 'Send message' }).click()

  const answer = page.getByRole('main').locator('p').filter({ hasText: 'word0' })
  await expect(answer).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: /Stop/ }).first()).toBeVisible()

  // The pick goes through at once: no question, no refusal.
  const swapsBefore = (await engineCalls(page)).length
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
  await page.getByTestId('model-picker-menu').getByRole('button', { name: /gemma-3-12b/i }).click()
  await expect.poll(async () => (await engineCalls(page)).slice(swapsBefore).some((p) => p.includes(SECOND))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The answer ends, keeps what was written, and names the reason.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('main').getByText('Stopped because you switched to another model')).toBeVisible()
  await expect(page.getByRole('main').getByText('Connection dropped before the end')).toHaveCount(0)
  await expect(answer).toBeVisible()
  await expect(page.getByRole('main').getByText('word59')).toHaveCount(0)

  // Nothing in or over the composer.
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Select chat model', exact: true })).toContainText(/gemma-3-12b/i)
})

test('an answer that runs to its end after no switch carries no such line', async ({ page }) => {
  await boot(page)
  await page.locator('textarea').first().fill('Tell me a long story')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('main').getByText('word59')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('main').getByText('Stopped because you switched to another model')).toHaveCount(0)
})
