import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone, routeCloud, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * UX pass 30.09.2026: Code tab, 900 px window, explorer open, cloud model, a
 * run in flight. The composer's action row is one fixed line, and it was
 * wider than the composer: Stop sat outside the frame, next to the panel
 * border. The fix lets the model name ellipsize and turns the Think and
 * Sampling words into icons below 30rem (ChatInput.tsx, @container).
 *
 * Measured on the running tree: the row does not overflow, and Stop sits
 * inside the composer.
 */

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }

async function bootCodeOnCloud(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.route('**/api/inference/v1/models', (route) => route.fulfill({
    status: 200, headers: cors, contentType: 'application/json',
    body: JSON.stringify({ object: 'list', data: [
      { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', context_length: 262144, supports_tools: true, think: 'never' },
    ] }),
  }))
  // The step never answers inside the test, so the run stays in flight.
  await page.route('**/api/inference/v1/chat/completions', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    await new Promise((res) => setTimeout(res, 60_000))
    return route.fulfill({ status: 200, headers: cors, contentType: 'text/event-stream', body: 'data: [DONE]\n\n' }).catch(() => {})
  })
  await page.goto('/')
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked()
  // Model first, in a plain chat, then the Code tab (same order as a user
  // who arrives from the chat).
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
  await page.getByRole('button', { name: /Kimi K2\.6/ }).first().click()
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(async () => {
    await page.getByRole('button', { name: /New Chat/i }).first().click()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

test('Code tab at 900 px with the explorer open: Stop stays inside the composer', async ({ page }) => {
  await bootCodeOnCloud(page)
  const box = page.locator('textarea').first()
  await box.fill('build the page')
  await box.press('Enter')
  await page.setViewportSize({ width: 900, height: 700 })

  const slot = page.getByTestId('composer-send-slot')
  await expect(slot.getByRole('button')).toBeVisible()

  await expect(async () => {
    const m = await slot.evaluate((el) => {
      const row = el.parentElement as HTMLElement
      // The composer frame: the nearest ancestor with a visible border.
      let frame: HTMLElement | null = row.parentElement
      while (frame && getComputedStyle(frame).borderTopWidth === '0px') frame = frame.parentElement
      const s = el.getBoundingClientRect()
      const f = (frame ?? row).getBoundingClientRect()
      return { overflow: row.scrollWidth - row.clientWidth, stopRight: s.right, frameRight: f.right }
    })
    expect(m.overflow).toBeLessThanOrEqual(0)
    expect(m.stopRight).toBeLessThanOrEqual(m.frameRight)
  }).toPass({ timeout: 10_000 })

  // The model is still named, only shorter.
  await expect(page.getByRole('button', { name: 'Select chat model', exact: true })).toBeVisible()
})
