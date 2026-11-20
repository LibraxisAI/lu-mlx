import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * GitHub #149 (CachyOS with Hyprland, AppImage): in Create the model
 * list opened downward and was cut off by the bottom edge of the window, so no
 * model could be picked. A tiling window manager makes short windows normal.
 *
 * What is measured here is the promise itself, in a real layout: the open
 * list lies completely inside the window, it sits on its trigger, and a model
 * at the very end of the list can be reached and picked.
 */

const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}

async function bootIntoCloudCreate(page: Page) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, tierCatalog: true })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  // Below 1024 px the top navigation folds into its menu.
  const create = page.getByRole('button', { name: /^Create$/ })
  if (await create.isVisible()) await create.click()
  else {
    await page.getByRole('button', { name: 'Main navigation' }).click()
    await page.getByRole('menuitem', { name: 'Create' }).click()
  }
  await page.getByRole('radio', { name: 'Image', exact: true }).click()
}

const picker = (page: Page) => page.locator('button[aria-haspopup="listbox"]').first()

/** Menu, trigger and window, all in visible pixels, once the open animation has settled. */
async function measure(page: Page) {
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await expect
    .poll(() => list.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).opacity))
    .toBe('1')
  return page.evaluate(() => {
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement
    const menu = listbox.parentElement as HTMLElement
    const trigger = document.querySelector('button[aria-haspopup="listbox"]') as HTMLElement
    const m = menu.getBoundingClientRect()
    const t = trigger.getBoundingClientRect()
    return {
      menu: { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
      trigger: { top: t.top, bottom: t.bottom, left: t.left, right: t.right },
      width: window.innerWidth,
      height: window.innerHeight,
      listVisible: listbox.clientHeight,
      listContent: listbox.scrollHeight,
    }
  })
}

function expectInsideWindow(m: Awaited<ReturnType<typeof measure>>) {
  expect(m.menu.top, 'the list starts above the window').toBeGreaterThanOrEqual(0)
  expect(m.menu.bottom, `the list runs ${Math.round(m.menu.bottom - m.height)} px below the window`).toBeLessThanOrEqual(m.height)
  expect(m.menu.left, 'the list starts left of the window').toBeGreaterThanOrEqual(0)
  expect(m.menu.right, 'the list runs past the right edge').toBeLessThanOrEqual(m.width)
}

/** The list hangs on its trigger: a few pixels of gap, never a hand's width. */
function expectOnTrigger(m: Awaited<ReturnType<typeof measure>>) {
  const above = m.menu.bottom <= m.trigger.top + 1
  const gap = above ? m.trigger.top - m.menu.bottom : m.menu.top - m.trigger.bottom
  expect(gap, 'gap between trigger and list').toBeGreaterThanOrEqual(0)
  expect(gap, 'gap between trigger and list').toBeLessThanOrEqual(8)
  // The picker is right-aligned: both right edges line up.
  expect(Math.abs(m.menu.right - m.trigger.right), 'right edges of trigger and list').toBeLessThanOrEqual(2)
}

test('in a short window the model list stays inside it and the last model can be picked', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 })
  await bootIntoCloudCreate(page)
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })
  await picker(page).click()

  const m = await measure(page)
  expectInsideWindow(m)
  expectOnTrigger(m)

  // The last row is one of the older models at the far end of the list.
  const last = page.getByRole('option', { name: /Flux Dev \(quality\)/ })
  await last.scrollIntoViewIfNeeded()
  // Not ratio 1: WebKit reports a fully visible row as 0.9986 (subpixels).
  await expect(last).toBeInViewport({ ratio: 0.95 })
  await last.click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(picker(page)).toContainText('Flux Dev (quality)')
})

test('in a very short window the list scrolls instead of leaving it', async ({ page }) => {
  // Neither side of the trigger has room for the whole list here. Without the
  // cap it would run out of the window again, and with a minimum height too.
  // The window shrinks after sign-in: the sign-in sheet itself needs more
  // than 230 px, which is not what this test is about.
  await page.setViewportSize({ width: 900, height: 700 })
  await bootIntoCloudCreate(page)
  await page.setViewportSize({ width: 900, height: 230 })
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })
  await picker(page).click()

  const m = await measure(page)
  expectInsideWindow(m)
  expectOnTrigger(m)
  expect(m.listContent, 'the list should have had to scroll here').toBeGreaterThan(m.listVisible)

  const last = page.getByRole('option', { name: /Flux Dev \(quality\)/ })
  await last.scrollIntoViewIfNeeded()
  await last.click()
  await expect(picker(page)).toContainText('Flux Dev (quality)')
})

test('in a tall window the list sits on its trigger as well', async ({ page }) => {
  // The other half of the report: with the window at full height the list was
  // still out of reach. Wherever it opens, it opens at its trigger.
  await page.setViewportSize({ width: 1240, height: 1000 })
  await bootIntoCloudCreate(page)
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })
  await picker(page).click()

  const m = await measure(page)
  expectInsideWindow(m)
  expectOnTrigger(m)
})

test('the open list follows when the window gets shorter', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await bootIntoCloudCreate(page)
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })
  await picker(page).click()
  expectInsideWindow(await measure(page))

  // A tiling window manager opens a second window: ours is half as tall now.
  await page.setViewportSize({ width: 1000, height: 400 })
  await expect.poll(async () => {
    const m = await measure(page)
    const gap = Math.min(Math.abs(m.trigger.top - m.menu.bottom), Math.abs(m.menu.top - m.trigger.bottom))
    return m.menu.top >= 0 && m.menu.bottom <= m.height && gap <= 8
  }).toBe(true)
  const m = await measure(page)
  expectInsideWindow(m)
  expectOnTrigger(m)

  // Escape still closes it.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
})
