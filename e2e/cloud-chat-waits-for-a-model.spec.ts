import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * In Cloud mode the app never picks a chat model by itself (2026-10-05).
 *
 * Measured that day: a new account chatted on the head of the hosted
 * catalogue, Llama 3.1 8B Turbo, without ever having picked it. That model
 * declines adult fiction, and a refusal in the history is then copied by
 * better models in the same chat.
 *
 * The catalogue of the mock is headed by exactly that model. After the switch
 * to Cloud the picker has to read "Choose a model", a send has to keep text
 * and attachment and open the picker, and the message has to go out on the
 * model the user then names, and on no other.
 *
 * The local side of the mock holds a model the automatic pick would take
 * (7B), so this also shows that the local pick does not leak into Cloud.
 *
 * Run: CI=1 LU_E2E_PORT=5311 npx playwright test e2e/cloud-chat-waits-for-a-model.spec.ts
 */

const TEXT = 'a message that waits for its model'
const NOTE = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('the attachment stays too') }
const HINT = 'Choose a model to send your message. Your text and attachments are kept.'
const REPLY = 'Cloud answer on the named model.'
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }

const picker = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')

test('Cloud: no model is picked for the user, and the message goes out on the one he names', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  const sentModels: string[] = []
  await page.route('**/api/inference/v1/chat/completions', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    sentModels.push((route.request().postDataJSON() as { model: string }).model)
    return route.fulfill({
      status: 200, headers: CORS, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: REPLY } }] })}\n\ndata: [DONE]\n\n`,
    })
  })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible()
  // Before the switch the local automatic pick is in place, as it always was.
  await expect(picker(page)).toContainText('qwen2.5-7b')
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked()

  // The catalogue is there, and nothing of it is picked.
  await expect(picker(page)).toContainText('Choose a model')
  await expect(page.getByText('Choose a model below.', { exact: true })).toBeVisible()
  await picker(page).click()
  await expect(menu(page).getByRole('button', { name: /Llama 3.1 8B Turbo/ })).toBeVisible()
  // The menu says what the pick is for, in the words of the web app. That is
  // the only place: nothing of it stands in or above the prompt field.
  await expect(page.getByTestId('picker-choose-a-model')).toHaveText('Choose a model to send your message.')
  await expect(page.getByText('Choose a model to send your message.')).toHaveCount(1)
  await expect(menu(page).getByText(HINT)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(picker(page)).toContainText('Choose a model')

  // A send keeps everything and opens the picker with the reason.
  const box = page.locator('textarea').first()
  await box.fill(TEXT)
  await page.locator('input[type="file"]').first().setInputFiles(NOTE)
  await expect(page.getByText('notes.txt')).toBeVisible()
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(box).toHaveValue(TEXT)
  await expect(page.getByText('notes.txt')).toBeVisible()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByText(HINT)).toBeVisible()
  // The reason stands in the picker and nowhere else on the page.
  await expect(page.getByText(HINT)).toHaveCount(1)
  expect(sentModels).toEqual([])

  // Naming a model and sending again delivers the kept message on that model.
  await menu(page).getByRole('button', { name: /Qwen3 30B A3B/ }).click()
  await expect(picker(page)).toContainText('Qwen3 30B A3B')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(box).toHaveValue('')
  await expect(page.getByRole('main').locator('p').filter({ hasText: REPLY })).toBeVisible({ timeout: 15_000 })
  expect(sentModels).toEqual(['Qwen/Qwen3-30B-A3B'])

  // The pick is the user's now: a trip to Local and back returns to it, and
  // each side keeps its own. (A reload is not asked here, the mock harness
  // comes back signed out and in Local mode.)
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked()
  await expect(picker(page)).toContainText('qwen2.5-7b')
  // Into Cloud the switch asks twice: the first click arms it.
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).toHaveAttribute('data-armed', 'true')
  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await expect(picker(page)).toContainText('Qwen3 30B A3B')
})
