import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Sending without a chat model must not lose the message.
 *
 * Found in the real Windows build of 3.0.5: with no chat model picked (the
 * picker reads "Choose a model") the Send button was live, and a click with
 * text, with or without attachments, emptied the field and the chips. No
 * conversation appeared and nothing was said: the message was gone.
 *
 * The mock installs one model that is too small for the automatic pick, so
 * the app starts with a model on disk and none chosen. Send has to leave the
 * text and the attachment where they are and open the model picker, which
 * says what is missing. Nothing may be written in or above the prompt field.
 *
 * Run: CI=1 npx playwright test e2e/send-without-a-model-keeps-the-message.spec.ts
 */

const SMALL_MODEL = 'Hermes-3-Llama-3.2-3B.Q4_K_M'
const TEXT = 'a message that must not get lost'
const NOTE = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('the attachment stays too') }
const HINT = 'Choose a model to send your message. Your text and attachments are kept.'

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: SMALL_MODEL })
  await seedOnboardingDone(page)
  await page.goto('/')
}

const picker = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')
const LANDING = 'Choose a model below. Automatic picks require a known size of at least 7B.'

for (const how of ['the Send button', 'Enter'] as const) {
  test(`Chat, ${how}: text and attachment stay, and the model picker opens with the reason`, async ({ page }) => {
    await boot(page)
    await expect(picker(page)).toContainText('Choose a model')
    const box = page.locator('textarea').first()
    await box.fill(TEXT)
    await page.locator('input[type="file"]').first().setInputFiles(NOTE)
    await expect(page.getByText('notes.txt')).toBeVisible()

    if (how === 'Enter') { await box.focus(); await page.keyboard.press('Enter') }
    else await page.getByRole('button', { name: 'Send message' }).click()

    // Nothing is lost.
    await expect(box).toHaveValue(TEXT)
    await expect(page.getByText('notes.txt')).toBeVisible()
    // No conversation was started: the landing page is still there.
    await expect(page.getByText(LANDING)).toBeVisible()
    // And the picker says what is missing.
    await expect(menu(page)).toBeVisible()
    await expect(menu(page).getByText(HINT)).toBeVisible()

    // The reason stands in the picker, nowhere else on the page.
    await expect(page.getByText(HINT)).toHaveCount(1)

    // Picking the model there and sending again delivers the kept message.
    await menu(page).getByRole('button').filter({ hasText: 'Hermes' }).click()
    await expect(picker(page)).toContainText('Hermes')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(box).toHaveValue('')
    await expect(page.getByText(LANDING)).toHaveCount(0)
    await expect(page.getByText(TEXT).first()).toBeVisible()
    await expect(page.getByText(DEFAULT_ASSISTANT_REPLY).first()).toBeVisible({ timeout: 15_000 })
  })
}

test('Chat: closing the picker without a pick leaves a mark on the model button, and the draft stays', async ({ page }) => {
  await boot(page)
  const box = page.locator('textarea').first()
  await box.fill(TEXT)
  await expect(page.getByTestId('picker-send-needs-model-dot')).toHaveCount(0)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(page.getByTestId('picker-send-needs-model-dot')).toBeVisible()
  await expect(box).toHaveValue(TEXT)
  await expect(page.getByText(HINT)).toHaveCount(0)
})

test('Code: the instruction stays and the model picker opens with the reason', async ({ page }) => {
  await boot(page)
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(picker(page)).toContainText('Choose a model')
  const box = page.locator('textarea').first()
  await box.fill(TEXT)
  await box.focus()
  await page.keyboard.press('Enter')
  await expect(box).toHaveValue(TEXT)
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByText(HINT)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(menu(page)).toBeVisible()
  await expect(box).toHaveValue(TEXT)
})
