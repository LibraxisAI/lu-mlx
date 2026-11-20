import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Discord 2026-10-01 (Windows): "the download from
 * library doesnt actually work". The gallery strip's Download built a blob and
 * clicked an <a download>, which WebView2 does not save. It now takes the same
 * path as the result view: the bytes from ComfyUI into the native Save dialog.
 */

const FILE = 'red_apple_on_a_plate_k3f9q2_00001_.png'

test('Download in the gallery strip opens the native Save dialog with the render', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([file]) => {
    localStorage.setItem('create-store', JSON.stringify({
      state: {
        backend: 'local',
        gallery: [{
          id: 'g1', type: 'image', filename: file, subfolder: '', prompt: 'a red apple on a plate', negativePrompt: '',
          model: 'juggernautXL.safetensors', modelType: 'sdxl', seed: 7, steps: 20, cfgScale: 7, sampler: 'euler',
          scheduler: 'simple', width: 512, height: 512, batchSize: 1, createdAt: Date.now(),
        }],
      },
      version: 2,
    }))
    const w = window as unknown as { __SAVES__: unknown[]; __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } }
    w.__SAVES__ = []
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    bridge.invoke = (command, args) => {
      if (command === 'save_binary_file_dialog') {
        w.__SAVES__.push({ defaultName: args.defaultName, size: (args.bytes as number[]).length })
        return Promise.resolve('C:\\Users\\me\\Downloads\\' + String(args.defaultName))
      }
      const url = String(args?.url ?? '')
      if (command === 'proxy_localhost_stream' && url.includes('/view?')) return Promise.resolve([137, 80, 78, 71, 1, 2, 3])
      if (command === 'proxy_localhost' && url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [] }))
      return invoke(command, args)
    }
  }, [FILE] as const)

  // A running ComfyUI serves the thumbnail; without it the tile reads unavailable.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.route('**/view?**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }))
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('button', { name: 'Open the gallery' }).click()
  const tile = page.locator('aside').filter({ hasText: 'Gallery' }).locator('.group').first()
  await tile.hover()
  await tile.getByTitle('Download').click()

  await expect.poll(() => page.evaluate(() => (window as unknown as { __SAVES__: unknown[] }).__SAVES__))
    .toEqual([{ defaultName: FILE, size: 7 }])
})
