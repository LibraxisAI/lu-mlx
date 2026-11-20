import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * Voice has no cloud service yet. With the Cloud switch on it goes the way
 * Benchmark and Models go: no tab, no palette entry, and a Voice view that was
 * open hands over to Chat. Back in Local it is there again.
 */

const voiceTab = (page: Page) => page.getByRole('banner').getByRole('button', { name: 'Voice', exact: true })

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
}

async function paletteOffers(page: Page, label: string): Promise<boolean> {
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await page.keyboard.type(label)
  const offered = await palette.getByRole('option', { name: label, exact: true }).count()
  // On the build machine the palette once stayed open for 15 s after a single
  // Escape (one run in four, never on a desktop). Why that press was lost is
  // not known. Press until it is gone.
  await expect(async () => {
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  return offered > 0
}

test('an open Voice view hands over to Chat when Cloud goes on, and the tab is gone', async ({ page }) => {
  await boot(page)
  await expect(voiceTab(page)).toBeVisible()
  await voiceTab(page).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()

  await signInViaGate(page)
  // The gate is a dialog, and an open dialog takes the page behind it out of
  // the accessibility tree. Asked before it closes, "no Voice tab" would be
  // true of every tab.
  await expect(page.getByRole('dialog', { name: 'LU Cloud' })).toBeHidden({ timeout: 20_000 })
  await expect(cloudSwitch(page)).toBeChecked()

  await expect(page.getByTestId('voice-view')).toHaveCount(0)
  await expect(voiceTab(page)).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('button', { name: 'Chat', exact: true })).toBeVisible()
  expect(await paletteOffers(page, 'Voice')).toBe(false)

  await cloudSwitch(page).click()
  await expect(cloudSwitch(page)).not.toBeChecked()
  await expect(voiceTab(page)).toBeVisible()
  expect(await paletteOffers(page, 'Voice')).toBe(true)
})
