import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * P3b acceptance test — fresh onboarding → first chat over the built-in engine.
 *
 * With no external provider running (the Tauri mock reports Ollama/LM
 * Studio/ComfyUI unreachable), a brand-new install must be able to:
 *   welcome → pick built-in (preselected) → download starter GGUF →
 *   boot the bundled engine → finish → send a message → get a streamed reply.
 *
 * The reply text is a fixed marker the mocked engine "generates", so a green
 * run proves the whole managed-backend chat path is wired end to end.
 */

async function installMock(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
}

test('small GPU keeps the 7B starter visible with a memory advisory', async ({ page }) => {
  await installMock(page)
  await page.addInitScript(() => {
    const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: { url?: string }) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = bridge.invoke
    bridge.invoke = (command, args) => command === 'proxy_localhost' && args?.url?.includes('/system_stats')
      ? Promise.resolve(JSON.stringify({ devices: [{ name: 'Test GPU', type: 'cuda', vram_total: 2 * 1024 ** 3 }] }))
      : invoke(command, args)
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Get Started/i }).click()
  await page.getByRole('button', { name: /Continue/i }).click()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  const starter = page.getByRole('button', { name: /Qwen 2\.5 7B/i })
  await expect(starter).toBeVisible()
  await expect(starter).toContainText('Full GPU offload may not fit.')
  await expect(page.getByRole('button', { name: /0\.5B/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible()
})

test('fresh onboarding boots the built-in engine and answers a chat', async ({ page }) => {
  await installMock(page)
  await page.goto('/')

  // welcome
  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()

  // backends — built-in engine is preselected, just continue
  await expect(page.getByRole('button', { name: /Continue/i })).toBeVisible()
  await page.getByRole('button', { name: /Continue/i }).click()

  // comfyui — skip (built-in text path doesn't need image gen)
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible()
  await page.getByRole('button', { name: /Skip for now/i }).click()

  // models — select the starter GGUF, then install. The step auto-advances to
  // embeddings once the (mocked) download completes and the engine boots.
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 7B/i }).click()
  const installBtn = page.getByRole('button', { name: /Install \d+ model/i })
  await expect(installBtn).toBeVisible()
  await installBtn.click()

  // embeddings — skip; onboarding is Ollama-free on the built-in path
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible({ timeout: 30_000 })
  const downloads = await page.evaluate(() => (window as unknown as { __E2E_DL_CALLS__: unknown[] }).__E2E_DL_CALLS__)
  expect(downloads).toContainEqual(expect.objectContaining({
    filename: 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf',
    expectedBytes: 4683073920,
    expectedSha256: 'da9272f09cd51d27aaadf37c1a2a3e079763682688aa1601d7406062b0caa5aa',
  }))
  await page.getByRole('button', { name: /Skip for now/i }).click()

  // done — finish sets onboardingDone and reveals the chat UI
  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()

  // chat — open a fresh conversation, which reveals the composer
  await openNewChat(page)
  const composer = page.locator('textarea').first()
  await composer.fill('ping the built-in engine')
  await page.getByRole('button', { name: /Send message/i }).click()

  // streamed assistant reply from the mocked built-in engine
  await expect(page.getByText(/PONG_BUILTIN_OK/)).toBeVisible({ timeout: 20_000 })
})
