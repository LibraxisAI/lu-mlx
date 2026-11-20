import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { giveMachineMemory } from './support/mac-memory'

/**
 * Screenshots of the Mac Model Manager for a design review, not a test of
 * anything. It only runs when LU_DESIGN_SHOTS names a folder:
 *
 *   LU_DESIGN_SHOTS=/path/to/folder LU_E2E_PORT=5411 npx playwright test e2e/design-shots.spec.ts --project=chromium
 *
 * One picture per theme, width, rail and view, plus the tile states that only
 * show while something is going on. LU_DESIGN_REFS=1 adds the other views of
 * the app (Chat, Create, Settings) as a reference for the house style.
 */

const OUT = process.env.LU_DESIGN_SHOTS
const REFS = !!process.env.LU_DESIGN_REFS

const MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  mlx: { engineInstalled: true, videoEngineInstalled: true, installedImages: ['sd-turbo', 'juggernaut-xl-v9'], installedVideos: ['wan21-t2v-1.3b'] },
}

type Theme = 'dark' | 'light'

async function open(page: Page, opts: TauriMockOptions, width: number, theme: Theme, ramGb = 32) {
  await page.addInitScript(tauriMockInit, opts)
  await giveMachineMemory(page, { ramGb, vramGb: ramGb })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (isDark !== (theme === 'dark')) {
    await page.getByRole('banner').getByTitle(/^(Light|Dark) Mode$/).click()
  }
}

async function nav(page: Page, width: number, name: string) {
  const banner = page.getByRole('banner')
  if (width < 1024) {
    await banner.getByRole('button', { name: 'Main navigation' }).click()
    await banner.getByRole('menuitem', { name, exact: true }).click()
  } else {
    await banner.getByRole('button', { name, exact: true }).click()
  }
}

const rail = (page: Page, name: string) =>
  page.locator('aside').getByRole('button', { name: new RegExp(`^${name}`) })

async function shot(page: Page, name: string) {
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

test.skip(!OUT, 'set LU_DESIGN_SHOTS to a folder to write the pictures')

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1440, 1024, 760]) {
    test(`${theme} ${width}: every rail, both views`, async ({ page }) => {
      await open(page, MAC, width, theme)
      await nav(page, width, 'Models')
      for (const name of ['Chat', 'Image', 'Video'] as const) {
        await rail(page, name).click()
        for (const view of ['Get new', 'Installed'] as const) {
          await page.getByRole('button', { name: new RegExp(`^${view}`) }).first().click()
          await shot(page, `${theme}-${width}-${name.toLowerCase()}-${view === 'Get new' ? 'get-new' : 'installed'}`)
        }
      }
    })
  }

  test(`${theme}: the states of a tile and of the engine`, async ({ page }) => {
    // A fresh Mac with 16 GB: the engine is missing, the big models do not fit.
    await open(page, { ...MAC, mlx: { engineInstalled: false, videoEngineInstalled: false, installedImages: [], installedVideos: [], installPolls: 60 } }, 1440, theme, 16)
    await nav(page, 1440, 'Models')
    await rail(page, 'Image').click()
    await shot(page, `${theme}-1440-image-state-engine-missing`)
    await page.getByRole('button', { name: /^Installed/ }).first().click()
    await shot(page, `${theme}-1440-image-state-empty`)
    await page.getByRole('button', { name: /^Get new/ }).first().click()
    await page.locator('[data-mac-media-tile="dreamshaper-xl-turbo"]').getByRole('button', { name: /^Get/ }).click()
    await page.waitForTimeout(1500)
    await shot(page, `${theme}-1440-image-state-engine-first`)
  })

  test(`${theme}: a model download in flight`, async ({ page }) => {
    await open(page, { ...MAC, mlx: { engineInstalled: true, installedImages: ['sd-turbo'], installPolls: 60 } }, 1440, theme, 16)
    await nav(page, 1440, 'Models')
    await rail(page, 'Image').click()
    const pick = page.locator('[data-mac-media-tile="flux2-klein-4b"]')
    await pick.getByRole('button', { name: /^Get/ }).click()
    await expect(pick).toHaveAttribute('data-state', 'installing', { timeout: 15_000 })
    await page.waitForTimeout(2500)
    await shot(page, `${theme}-1440-image-state-installing`)
  })

  test(`${theme}: the same page on a PC, with the LoRA rail`, async ({ page }) => {
    await open(page, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' }, 1440, theme)
    await nav(page, 1440, 'Models')
    for (const name of ['Chat', 'Image', 'Video', 'LoRAs'] as const) {
      const item = rail(page, name)
      if (await item.count() === 0) continue
      await item.click()
      for (const view of ['Get new', 'Installed'] as const) {
        await page.getByRole('button', { name: new RegExp(`^${view}`) }).first().click()
        await shot(page, `${theme}-1440-pc-${name.toLowerCase()}-${view === 'Get new' ? 'get-new' : 'installed'}`)
      }
    }
  })

  if (REFS) {
    test(`${theme}: the rest of the app as a reference`, async ({ page }) => {
      await open(page, MAC, 1440, theme)
      await shot(page, `ref-${theme}-chat`)
      for (const name of ['Create', 'Voice', 'Settings']) {
        await nav(page, 1440, name)
        await shot(page, `ref-${theme}-${name.toLowerCase()}`)
      }
    })
  }
}
