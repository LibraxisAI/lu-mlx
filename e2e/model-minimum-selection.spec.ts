import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

test('small installed model waits for a choice and preserves that explicit choice on reload', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: 'Hermes-3-Llama-3.2-3B.Q4_K_M' })
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByText('Choose a model below. Automatic picks require a known size of at least 7B.')).toBeVisible()
  const picker = page.getByRole('button', { name: 'Select chat model', exact: true })
  await expect(picker).toContainText('Choose a model')
  await picker.click()
  await page.getByRole('button').filter({ hasText: 'Hermes' }).click()
  await expect(picker).toContainText('Hermes')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Select chat model', exact: true })).toContainText('Hermes')
})
