import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { giveMachineMemory } from './support/mac-memory'

/**
 * A chat tile on Windows and Linux keeps its button inside its own edge.
 *
 * Seen in the real Windows build on 10.10.2026, window 1296 px wide: under
 * Chat, Get new, the Get buttons stood out over the right edge of their
 * tiles, and the list had a sideways scroll bar at its foot. The row of a
 * tile holds the size picker, the verdict, the download count and the
 * button, and none of them gave way; three columns at that width leave the
 * row less room than the four of them need.
 *
 * The widths are the one it was seen at, the first one with three columns,
 * and one on each side of the two-column step.
 */
const PC: TauriMockOptions = { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'windows' }

for (const width of [1296, 1280, 1024, 1023, 760]) {
  test(`${width} px: every button inside its tile, no sideways scroll`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, PC)
    await giveMachineMemory(page, { ramGb: 32, vramGb: 12 })
    await seedOnboardingDone(page)
    await routeCloud(page, { license: 'active', access: true, mediaLive: true })
    await page.setViewportSize({ width, height: 808 })
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
    const pane = page.getByTestId('models-pane')
    await expect(pane.locator('[data-model-tile]').first()).toBeVisible({ timeout: 30_000 })

    for (const catalogue of ['Mainstream', 'Unfiltered']) {
      await pane.getByRole('group', { name: 'Catalogue' }).getByRole('button', { name: new RegExp(catalogue) }).click()
      await expect(pane.locator('[data-model-tile]').first()).toBeVisible()
      const report = await pane.evaluate((el) => {
        const out: string[] = []
        const tiles = [...el.querySelectorAll<HTMLElement>('[data-model-tile]')]
        for (const tile of tiles) {
          const edge = tile.getBoundingClientRect()
          for (const part of tile.querySelectorAll<HTMLElement>('button, [data-fit]')) {
            const box = part.getBoundingClientRect()
            if (box.width === 0) continue
            if (box.right > edge.right - 1 || box.left < edge.left + 1) {
              out.push(`${tile.dataset.modelTile}: "${part.textContent?.trim()}" ends at ${Math.round(box.right)}, the tile at ${Math.round(edge.right)}`)
            }
          }
        }
        return { tiles: tiles.length, out, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      })
      expect(report.tiles, catalogue).toBeGreaterThan(3)
      expect(report.out, catalogue).toEqual([])
      expect(report.scrollWidth, catalogue).toBeLessThanOrEqual(report.clientWidth)
    }
  })
}
