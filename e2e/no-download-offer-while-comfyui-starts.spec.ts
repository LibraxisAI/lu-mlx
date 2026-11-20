import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * 3.0.4 Gegenprobe on the Windows box (02.10.2026): right after launch the
 * stage offered "Local image generation needs a one-time download ...
 * Juggernaut XL (~6.5 GB)" while the line above said "ComfyUI is starting
 * up." and the models were already on disk. A click would have downloaded
 * them again. While ComfyUI is starting there is no offer; when it is neither
 * running nor starting, the offer is the way out and stays.
 */

async function boot(page: Page, starting: boolean) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript((s) => {
    const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = bridge.invoke
    bridge.invoke = (command, args) => command === 'comfyui_status'
      ? Promise.resolve({ running: false, starting: s, isLocal: true, found: true })
      : invoke(command, args)
  }, starting)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
}

test('while ComfyUI is starting the stage offers no download', async ({ page }) => {
  await boot(page, true)
  await expect(page.getByText('ComfyUI is starting up.')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  await expect(page.getByText('Local image generation needs a one-time download')).toHaveCount(0)
  // Gegenprobe 8: a red "is not running" stood next to "is starting up".
  await expect(page.getByText(/ComfyUI is not running/)).toHaveCount(0)
})

// Negative control: nothing running and nothing starting, so the card is the
// one way to a working setup and has to be there.
test('with ComfyUI neither running nor starting the offer is there', async ({ page }) => {
  await boot(page, false)
  await expect(page.getByText('Local image generation needs a one-time download')).toBeVisible({ timeout: 15_000 })
})
