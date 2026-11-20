import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls } from './support/recorded'
import { gradientPng } from './support/png'
import { expectDataFetchRefused, serveWithAppPolicy } from './support/app-policy'

/**
 * Mac hand test of 3.0.6 (10.10.2026): an image made in the running session
 * could not be picked from the gallery as the Edit source. The stage said
 * "Could not load that gallery image: Load failed". Images of earlier days
 * worked.
 *
 * A fresh local render carries its bytes as a data: URL, and the app's
 * connect-src has no data: entry, so fetch() refuses it. The dev server of
 * this suite sends no such policy, so the test puts the connect-src of
 * tauri.conf.json on the page. Without it the pick passes for the wrong
 * reason.
 */

const MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  mlx: { installedImages: ['sd-turbo', 'qwen-image-2.1-8bit'], mfluxEngineInstalled: true },
}

async function bootCreateWithAppPolicy(page: Page, opts: TauriMockOptions) {
  await serveWithAppPolicy(page)
  await page.addInitScript(tauriMockInit, opts)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('banner').getByRole('button', { name: 'Create', exact: true }).click()
}

test('an image made in this session can be picked from the gallery as the Edit source', async ({ page }) => {
  const picture = gradientPng(1024, 768)
  await bootCreateWithAppPolicy(page, { ...MAC, mlx: { ...MAC.mlx, imageBase64: picture.toString('base64') } })

  await expectDataFetchRefused(page)

  await page.locator('textarea').first().fill('a red apple')
  await page.getByRole('button', { name: /^Create$/ }).last().click()
  await expect
    .poll(async () => (await mlxCalls(page)).filter((c) => c.cmd === 'mlx_generate').length, { timeout: 30_000 })
    .toBe(1)
  await expect(page.getByTestId('result-facts')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.getByRole('button', { name: 'Use this gallery image as the source' }).first().click()

  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Could not load that gallery image/)).toHaveCount(0)
})
