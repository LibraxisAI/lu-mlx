import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch, type CloudScenario } from './support/cloud-mock'

/**
 * 02.10.2026: der Modellwaehler im Create-Tab ordnet nach Stufe und nennt die
 * Herkunft, und der Desktop bricht nicht an einem Server, der beides nicht
 * liefert.
 *
 *  (a) Server mit `tier`/`weights`: "Best" steht oben und traegt die Marke,
 *      "Open weights" und "Open family" stehen daneben, die aelteren Modelle
 *      stehen gesammelt unter "Older models". Die Marken stehen NUR in der
 *      aufgeklappten Liste: nichts davon im oder ueber dem Prompt-Eingabefeld
 *      und nichts am geschlossenen Waehler.
 *  (b) Server von heute (keine der beiden Angaben, kein Nucleus): jede Zeile
 *      steht neutral da, keine Marke, keine Zwischenzeile, das neue Modell
 *      fehlt.
 */

const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}

async function bootIntoCloudCreate(page: Page, scenario: CloudScenario) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, scenario)
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
}

const picker = (page: Page) => page.locator('button[aria-haspopup="listbox"]').first()

test('server with tiers: Best on top with its mark, Older models collected below, marks only in the open list', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true, tierCatalog: true })
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })

  // Closed: no mark anywhere, least of all around the prompt field.
  await expect(page.getByText('Best', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Open weights', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Older models', { exact: true })).toHaveCount(0)

  await picker(page).click()
  const list = page.locator('.lu-elevated')
  await expect(list).toBeVisible()
  const names = await list.locator('button').evaluateAll((btns) => btns.map((b) => b.querySelector('.truncate')?.textContent ?? ''))
  // Z-Image Turbo is best, Nucleus follows, the two Flux models are older and go last.
  expect(names.slice(0, 2)).toEqual(['Z-Image Turbo (fast)', 'Nucleus'])
  expect(names.slice(-2)).toEqual(['Flux Schnell (fast)', 'Flux Dev (quality)'])
  await expect(list.getByText('Older models', { exact: true })).toHaveCount(1)
  await expect(list.getByText('Best', { exact: true })).toHaveCount(1)
  await expect(list.getByText('Open family', { exact: true })).toHaveCount(1)
  await expect(list.getByText('Open weights', { exact: true })).toHaveCount(3)

  // The prompt field and everything above it stay free of marks.
  const prompt = page.locator('textarea').first()
  await expect(prompt).toBeVisible()
  const around = await prompt.evaluate((el) => (el.closest('.rounded-\\[var\\(--radius-panel\\)\\]') ?? el.parentElement)?.textContent ?? '')
  expect(around).not.toMatch(/Best|Open weights|Open family|Older models/)

  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
})

test('server of today: every row stands neutral, no mark, no Older models row, no new model', async ({ page }) => {
  await bootIntoCloudCreate(page, { license: 'active', access: true, mediaLive: true })
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })
  await picker(page).click()
  const list = page.locator('.lu-elevated')
  await expect(list).toBeVisible()
  const names = await list.locator('button').evaluateAll((btns) => btns.map((b) => b.querySelector('.truncate')?.textContent ?? ''))
  expect(names).toEqual(['Flux Schnell (fast)', 'Flux Dev (quality)'])
  for (const mark of ['Best', 'Open weights', 'Open family', 'Older models']) {
    await expect(list.getByText(mark, { exact: true })).toHaveCount(0)
  }
})
