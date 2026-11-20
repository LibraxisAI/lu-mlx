import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * 01.10.2026: "Kann man das Kontextfenster nicht bei jedem Cloud-Modell
 * aendern?" The model's own window is fixed on LU Cloud, the lever is how much
 * of the chat each step sends. The header dropdown sets it per model and the
 * next request really sends within it.
 */
test('a cloud model gets its own context pick from the header dropdown', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }
  await page.route('**/api/inference/v1/models', (route) => route.fulfill({
    status: 200, headers: cors, contentType: 'application/json',
    body: JSON.stringify({ object: 'list', data: [{
      id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', context_length: 262144, supports_tools: true, think: 'never',
    }] }),
  }))
  await page.route('**/api/inference/v1/chat/completions', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    return route.fulfill({ status: 200, headers: cors, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` })
  })

  await page.goto('/')
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked()
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
  await page.getByRole('button', { name: /Kimi K2\.6/ }).first().click()

  const composer = page.locator('textarea').first()
  await composer.fill('hello')
  await composer.press('Enter')
  await expect(page.getByText('ok', { exact: true })).toBeVisible({ timeout: 15_000 })

  const knob = page.getByRole('button', { name: /Context window/ }).first()
  await expect(knob).toBeVisible({ timeout: 15_000 })
  // Default: the fill over the 32K send window, not over the model's 256K.
  await expect(knob).toContainText('/32K')
  // No warning on the default (30.09.2026: only once it was raised).
  await expect(page.getByLabel('Larger context costs more')).toHaveCount(0)

  await knob.click()
  await expect(page.getByRole('button', { name: /^Auto · 32K$/ })).toBeVisible()
  // Too small to hold one cloud step, so not offered.
  await expect(page.getByRole('button', { name: /^8K$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^64K$/ }).click()
  await expect(knob).toContainText('/64K')
  await expect(page.getByLabel('Larger context costs more')).toHaveCount(1)

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('chat-settings') || '{}').state?.settings?.cloudSendWindowByModel)
  expect(Object.values(saved ?? {})).toEqual([65536])

  // Back to Auto clears the pick.
  await knob.click()
  await page.getByRole('button', { name: /^Auto · 32K$/ }).click()
  await expect(knob).toContainText('/32K')
  await expect(page.getByLabel('Larger context costs more')).toHaveCount(0)
})
