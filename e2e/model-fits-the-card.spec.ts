import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, type AppWindow } from './support/ui'

/**
 * October 2026, the owner's box (RTX 3060, 12 GB): Z-Image stood more than
 * 300 s in "Loading the model into memory" and nothing had said beforehand
 * that the model is a tight fit there. A nachgebautes ComfyUI lists Z-Image
 * Turbo next to an SDXL checkpoint, and the Rust probe reports the card.
 *
 *  (a) Models: every bundle card compares itself with the detected card.
 *  (b) Without a detected card the cards say nothing about one.
 *  (c) Create: the tight model says so on its row in the model picker, never at
 *      the prompt field, and a load that runs past a minute names the reason.
 */

const ZIMAGE = 'z_image_turbo_bf16.safetensors'
const SDXL = 'Juggernaut-XL_v9.safetensors'

async function boot(page: Page, cardMib: number | null) {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' as const })
  await seedOnboardingDone(page)
  await page.addInitScript(([zimage, sdxl, mib]) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: { url?: string }) => Promise<unknown> } }
    if (!localStorage.getItem('create-store')) {
      localStorage.setItem('create-store', JSON.stringify({ state: { backend: 'local', imageModel: zimage }, version: 2 }))
    }
    const bridge = w.__TAURI_INTERNALS__
    const invoke = bridge.invoke
    const combo = (v: string[]) => [v]
    const nodes: Record<string, unknown> = {
      UNETLoader: { input: { required: { unet_name: combo([zimage as string]) } } },
      CheckpointLoaderSimple: { input: { required: { ckpt_name: combo([sdxl as string]) } } },
      CLIPLoader: { input: { required: { clip_name: combo(['qwen_3_4b.safetensors']) } } },
      VAELoader: { input: { required: { vae_name: combo(['ae.safetensors']) } } },
      KSampler: { input: { required: { sampler_name: combo(['euler']), scheduler: combo(['simple']) } } },
    }
    bridge.invoke = (command, args) => {
      if (command === 'detect_gpus') {
        return Promise.resolve(mib ? [{ index: 0, vendor: 'nvidia', name: 'RTX 3060', memory_mib: mib, source: 'fixture' }] : [])
      }
      if (command === 'sniff_model_files') return Promise.resolve([])
      if (command !== 'proxy_localhost' || !args?.url?.includes(':8188')) return invoke(command, args)
      const url = args.url
      // The card comes from the Rust probe alone, so (b) really has none.
      if (url.includes('/system_stats')) return Promise.resolve(JSON.stringify({ devices: [] }))
      const one = /\/object_info\/([^/?]+)/.exec(url)
      if (one) return Promise.resolve(JSON.stringify(one[1] in nodes ? { [one[1]]: nodes[one[1]] } : {}))
      if (url.includes('/object_info')) return Promise.resolve(JSON.stringify(nodes))
      return Promise.resolve('{}')
    }
  }, [ZIMAGE, SDXL, cardMib] as const)
}

const tile = (page: Page, name: string) => page.locator(`[data-bundle-tile="${name}"]`)

async function openImageCatalogue(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Models$/ }).first().click()
  await page.getByRole('button', { name: /^Image \d+$/ }).click()
}

test('Models: each bundle card compares itself with the detected 12 GB card', async ({ page }) => {
  await boot(page, 12288)
  await openImageCatalogue(page)

  const fits = tile(page, 'FLUX 2 Klein 4B (Next Gen)')
  await expect(fits).toBeVisible({ timeout: 20_000 })
  await expect(fits.locator('[data-bundle-fit="fits"]')).toHaveText('Fits your 12 GB card')
  // The companion files name no number, so their card claims nothing.
  const companion = tile(page, 'Krea 2 Companion Files (Text Encoder + VAE)')
  await expect(companion).toBeVisible()
  await expect(companion.locator('[data-bundle-fit]')).toHaveCount(0)

  const big = tile(page, 'ERNIE-Image Turbo')
  await expect(big.locator('[data-bundle-fit="big"]')).toHaveText('Needs more than your 12 GB card')

  await page.getByRole('button', { name: 'Unfiltered', exact: true }).click()
  const tight = tile(page, 'Z-Image Turbo (Unfiltered, Fast)')
  await expect(tight.locator('[data-bundle-fit="tight"]')).toHaveText('Tight on your 12 GB card: runs, loading can be slow')
  await expect(tight.locator('[data-bundle-fit]')).toHaveAttribute('title', 'Runs from 10 GB. Loads fully into graphics memory from 16 GB.')
  // The promise that did not hold on this card is gone from the card.
  await expect(tight).not.toContainText(/seconds per image/)

  // The line fits its card: nothing is cut off and nothing runs out of the tile.
  const inside = await tight.locator('[data-bundle-fit]').evaluate((el) => {
    const line = el.getBoundingClientRect()
    const box = el.closest('[data-bundle-tile]')!.getBoundingClientRect()
    return line.left >= box.left && line.right <= box.right && line.bottom <= box.bottom
  })
  expect(inside).toBe(true)
})

test('Models: without a detected card no bundle card names one', async ({ page }) => {
  await boot(page, null)
  await openImageCatalogue(page)
  await expect(tile(page, 'FLUX 2 Klein 4B (Next Gen)')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-bundle-fit]')).toHaveCount(0)
  await expect(page.getByText(/your \d+ GB card/)).toHaveCount(0)
})

test('Create: the tight model says so in the picker, and a load past a minute names the reason', async ({ page }) => {
  await boot(page, 12288)
  await page.goto('/')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()

  const picker = page.locator('button[aria-haspopup="listbox"]').first()
  await expect(picker).toContainText('Z-Image Turbo BF16', { timeout: 20_000 })
  // Closed: no word about the card anywhere, least of all at the prompt field.
  await expect(page.getByText(/your 12 GB card/)).toHaveCount(0)

  await picker.click()
  const list = page.locator('.lu-elevated')
  await expect(list).toBeVisible()
  await expect(list.getByRole('option', { name: /Z-Image Turbo BF16/ })).toContainText('Tight on your 12 GB card')
  const sdxlRow = list.getByRole('option', { name: /Juggernaut XL V9 Photo v2/ })
  await expect(sdxlRow).toBeVisible()
  await expect(sdxlRow).not.toContainText(/card/)
  await expect(list.getByText(/your 12 GB card/)).toHaveCount(1)

  const prompt = page.locator('textarea').first()
  const around = await prompt.evaluate((el) => (el.closest('.rounded-\\[var\\(--radius-panel\\)\\]') ?? el.parentElement)?.textContent ?? '')
  expect(around).not.toMatch(/card|graphics memory/)
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()

  // The waiting area, in the load phase, on the app's own store.
  // Loaded before the clock is installed: waiting for a module polls on the page's clock.
  await appModules(page, ['/src/stores/createStore.ts'])
  await page.clock.install()
  await page.evaluate(() => {
    const { useCreateStore } = (window as unknown as AppWindow).__APP__['/src/stores/createStore.ts']
    const s = useCreateStore.getState()
    s.setIsGenerating(true)
    s.setProgressPhase('loading-model')
    s.setProgress(15, 'Loading model...')
  })
  await expect(page.getByText('Loading model...')).toBeVisible()
  await page.clock.runFor(13_000)
  await expect(page.getByText('Loading the model into memory...')).toBeVisible()
  await expect(page.getByTestId('slow-load-hint')).toHaveCount(0)
  await page.clock.runFor(48_000)
  await expect(page.getByTestId('slow-load-hint')).toHaveText('This model is a tight fit for your graphics memory, so loading is slow.')
  await expect(page.getByText('Loading the model into memory...')).toBeVisible()
})
