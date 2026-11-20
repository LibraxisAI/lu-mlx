import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * 3.0.4 Gegenprobe 8 (02.10.2026): Models, Installed called the AnimateDiff
 * motion module v3_sd15_mm.ckpt "safetensors". Every ComfyUI file that was not
 * .gguf got that word. Here a nachgebautes ComfyUI lists a .ckpt next to a
 * .safetensors, and the cards must name each file's own format.
 */
test('an installed .ckpt is labelled ckpt, a .safetensors safetensors', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(() => {
    const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo(['dreamshaper_8.ckpt', 'juggernautXL.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
    } as Record<string, unknown>
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 3060', type: 'cuda', vram_total: 12 * 1024 ** 3 }] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Models$/ }).first().click()
  await page.getByRole('button', { name: /^Image \d+$/ }).click()
  await page.getByRole('button', { name: /^Installed/ }).click()

  const card = (name: string) => page.locator('div').filter({ hasText: name }).filter({ has: page.getByText(/^(ckpt|safetensors|gguf)$/) }).last()
  await expect(card('dreamshaper_8')).toBeVisible({ timeout: 20_000 })
  await expect(card('dreamshaper_8').getByText('ckpt', { exact: true })).toBeVisible()
  await expect(card('dreamshaper_8').getByText('safetensors', { exact: true })).toHaveCount(0)
  await expect(card('juggernautXL').getByText('safetensors', { exact: true })).toBeVisible()
})
