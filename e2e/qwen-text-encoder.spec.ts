import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * Qwen-Image 2.1 with both editions of its text encoder installed, the
 * official one and the one without refusals: the Expert settings have one row
 * to pick which one reads the prompt. A rebuilt ComfyUI answers through
 * proxy_localhost with a local Qwen-Image 2.1 and, per test, the files in its
 * text encoder folder. Nothing is rendered.
 *
 * Run once per image model file of the family: the official weights and the
 * Noct Q finetune, whose file name says neither "qwen" nor "2.1".
 */

const WEIGHTS = [
  ['official weights', 'qwen_image_2.1_int8_convrot.safetensors'],
  ['Noct Q', 'NoctQ_V4_int8_convrot.safetensors'],
] as const
const OFFICIAL = 'qwen3vl_8b_int8_convrot.safetensors'
const FREE = 'qwen3vl_8b_int8_convrot_heretic.safetensors'

async function bootWithFakeComfy(page: Page, model: string, textEncoders: string[]) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([model, encoders]) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: model }, version: 2 }))
    }
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes: Record<string, unknown> = {
      UNETLoader: { input: { required: { unet_name: combo([model as string]) } } },
      CLIPLoader: { input: { required: { clip_name: combo(encoders as string[]) } } },
      VAELoader: { input: { required: { vae_name: combo(['qwen_image_2.1_vae_bf16.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
    }
    bridge.invoke = (command, args) => {
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [{ name: 'RTX 4090', type: 'cuda', vram_total: 24 * 1024 ** 3 }] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, [model, textEncoders] as const)
}

async function openExpert(page: Page, intent: string) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: intent, exact: true }).click()
  await page.getByRole('button', { name: 'Advanced settings' }).click()
  const expert = page.getByRole('button', { name: 'Expert', exact: true })
  await expert.click()
  // The section opens over 180 ms, its body growing inside a clipping box. A
  // click on a row that is still clipped scrolls that box to reach it, the row
  // then slides back down as the box grows, and a list opened from it follows
  // it under the window edge. No hand is that fast; the test is. So it waits
  // for the body to stand at its full height, with nothing left clipped.
  await expect.poll(() => expert.evaluate((button) => {
    const body = button.parentElement?.nextElementSibling
    return body ? body.scrollHeight - body.clientHeight : -1
  })).toBe(0)
}

const row = (page: Page) => page.getByRole('button', { name: 'Text encoder', exact: true })
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('create-store') || '{}').state?.qwenTextEncoder)

for (const [weights, model] of WEIGHTS) {
  test(`${weights}: with both text encoders installed, Expert offers which one reads the prompt and remembers the pick`, async ({ page }) => {
    await bootWithFakeComfy(page, model, [OFFICIAL, FREE])
    await openExpert(page, 'Image')
    await expect(row(page)).toBeVisible({ timeout: 15_000 })
    await expect(row(page)).toHaveCount(1)
    await expect(row(page)).toHaveText('Qwen3-VL 8B')

    await row(page).click()
    await expect(page.getByRole('option')).toHaveText(['Qwen3-VL 8B', 'Qwen3-VL 8B, No Filter'])
    await page.getByRole('option', { name: 'Qwen3-VL 8B, No Filter' }).click()
    await expect(row(page)).toHaveText('Qwen3-VL 8B, No Filter')
    await expect.poll(() => saved(page)).toBe('unfiltered')

    // Nothing of it sits in or above the prompt field: with the drawer closed
    // the page shows no such row.
    await page.keyboard.press('Escape')
    await expect(row(page)).toHaveCount(0)
    await expect(page.getByText('Text encoder', { exact: true })).toHaveCount(0)

    // The pick is still there after a restart, and Edit shows the same row.
    await page.reload()
    await openExpert(page, 'Edit / Image to Image')
    await expect(row(page)).toHaveText('Qwen3-VL 8B, No Filter', { timeout: 15_000 })
  })

  test(`${weights}: with one text encoder installed there is nothing to choose and no row`, async ({ page }) => {
    await bootWithFakeComfy(page, model, [FREE])
    await openExpert(page, 'Image')
    await expect(page.getByText('Sampler', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(row(page)).toHaveCount(0)
  })
}
