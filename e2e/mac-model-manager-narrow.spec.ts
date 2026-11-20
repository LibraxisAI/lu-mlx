import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { giveMachineMemory } from './support/mac-memory'

/**
 * The Mac Model Manager below 1024 px. The view was only ever looked at from
 * about 1100 px up. A narrow window must not push anything out of the pane:
 * no sideways scroll, no control cut off at the right edge, and the top bar
 * keeps its search field.
 *
 * LU_SHOTS=<folder> also writes one screenshot per width, rail and view.
 */

const MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  mlx: { engineInstalled: true, videoEngineInstalled: true, installedImages: ['sd-turbo', 'juggernaut-xl-v9'], installedVideos: ['wan21-t2v-1.3b'] },
}
const SHOTS = process.env.LU_SHOTS

const rail = (page: Page, name: 'Chat' | 'Image' | 'Video') =>
  page.locator('aside:has(+ [data-testid="models-pane"])').getByRole('button', { name: new RegExp(`^${name}`) })

/** Everything visible in the content pane that reaches past its right edge. */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="models-pane"]') as HTMLElement | null
    if (!pane) return ['no models pane']
    const out: string[] = []
    if (pane.scrollWidth > pane.clientWidth + 1) out.push(`pane scrolls sideways: ${pane.scrollWidth} > ${pane.clientWidth}`)
    const edge = pane.getBoundingClientRect().right
    const say = (el: Element) => `${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`
    for (const el of pane.querySelectorAll('button, input, [data-mac-media-tile], [data-model-tile]')) {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right > edge + 1) out.push(`${say(el)} ends at ${Math.round(r.right)}, pane at ${Math.round(edge)}`)
    }
    // A tile clips what does not fit, so its own edge is the second border:
    // a Get button pushed past it is there in the tree and gone on screen.
    for (const tile of pane.querySelectorAll('[data-mac-media-tile], [data-model-tile]')) {
      const t = tile.getBoundingClientRect()
      for (const el of tile.querySelectorAll('button, [role="status"]')) {
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.right > t.right + 1 || r.left < t.left - 1) out.push(`${say(el)} leaves its tile "${(tile.querySelector('h3')?.textContent || '').trim()}"`)
      }
    }
    // One line per label: a segment whose text breaks in two has run out of room.
    for (const el of pane.querySelectorAll('[role="group"] button, [data-models-view] button')) {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.height > 40) out.push(`${say(el)} wraps (${Math.round(r.height)} px high)`)
    }
    return out
  })
}

for (const width of [1024, 900, 760]) {
  test(`${width} px: Chat, Image and Video keep inside the pane in both views`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, MAC)
    // With a known size the lanes draw their widest row: the hardware chip
    // and the "Fits my Mac" bucket.
    await giveMachineMemory(page, { ramGb: 32, vramGb: 32 })
    await seedOnboardingDone(page)
    await routeCloud(page, { license: 'active', access: true, mediaLive: true })
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
    // Below 1024 px the main navigation is a menu.
    const banner = page.getByRole('banner')
    if (width < 1024) {
      await banner.getByRole('button', { name: 'Main navigation' }).click()
      await banner.getByRole('menuitem', { name: 'Models', exact: true }).click()
    } else {
      await banner.getByRole('button', { name: 'Models', exact: true }).click()
    }

    for (const name of ['Chat', 'Image', 'Video'] as const) {
      await rail(page, name).click()
      for (const view of ['Get new', 'Installed'] as const) {
        await page.getByRole('button', { name: new RegExp(`^${view}`) }).click()
        if (name !== 'Chat') {
          await expect(page.getByTestId(`mac-media-${name.toLowerCase()}`)).toHaveAttribute('data-view', view === 'Get new' ? 'discover' : 'installed')
          await expect(page.locator('[data-mac-media-tile]').first()).toBeVisible()
        }
        await expect(page.getByPlaceholder('Search models…')).toBeVisible()
        // The tiles fade in; measure and shoot the settled page.
        await page.waitForTimeout(700)
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-${name.toLowerCase()}-${view === 'Get new' ? 'get-new' : 'installed'}.png` })
        expect(await overflowing(page), `${name} / ${view} at ${width} px`).toEqual([])
      }
    }
  })
}
