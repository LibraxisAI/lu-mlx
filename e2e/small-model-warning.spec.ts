import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

test('catalog warning is fully readable and retained in model details', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await page.addInitScript(() => {
    const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = bridge.invoke
    bridge.invoke = (command, args) => command === 'detect_gpus'
      ? Promise.resolve([{ index: 0, vendor: 'nvidia', name: 'Test GPU', memory_mib: 12288, source: 'fixture' }])
      : invoke(command, args)
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: 'Mainstream', exact: true }).click()
  const recommendations = page.getByRole('region', { name: 'Start here', exact: true })
  await expect(recommendations).toBeVisible()
  await expect(recommendations.getByTestId('small-chat-model-warning')).toHaveCount(0)
  await expect(recommendations.locator('[data-model-tile="Hermes 3 Llama 3.2 3B"]')).toHaveCount(0)
  const tile = page.locator('[data-model-tile="Hermes 3 Llama 3.2 3B"]')
  const warning = tile.getByTestId('small-chat-model-warning')
  await warning.scrollIntoViewIfNeeded()
  await expect(warning).toContainText('Not recommended for chat or agent work.')
  await page.setViewportSize({ width: 390, height: 844 })
  await warning.scrollIntoViewIfNeeded()
  await expect(warning).toBeVisible()
  const unclipped = await warning.evaluate(element => {
    const style = getComputedStyle(element)
    return element.scrollHeight <= element.clientHeight && style.webkitLineClamp === 'none'
  })
  expect(unclipped).toBe(true)
  await tile.getByRole('button', { name: 'Details for Hermes 3 Llama 3.2 3B', exact: true }).click()
  await expect(page.getByRole('dialog').getByText(/Below 7B:/)).toBeVisible()
})
