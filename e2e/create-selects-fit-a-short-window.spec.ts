import { test, expect, type Locator, type Page } from '@playwright/test'
import { bootWithFakeComfy, openImageExpert } from './support/fake-comfy'

/**
 * GitHub #149 was reported from the local lane (AppImage, tiling window
 * manager): the model list in Create opened downward and was cut off by the
 * bottom edge. create-model-picker-fits-the-window.spec.ts holds the Cloud
 * picker to the promise. This one holds every list of the same build in the
 * local lane to it: the model picker in the composer and the lists of the
 * advanced settings, in a short window, each with more rows than fit.
 */

const many = (n: number, name: (i: number) => string) => Array.from({ length: n }, (_, i) => name(i))
const CHECKPOINTS = many(30, (i) => `sdxl_checkpoint_${String(i).padStart(2, '0')}.safetensors`)
const SAMPLERS = many(24, (i) => `sampler_${String(i).padStart(2, '0')}`)
const SCHEDULERS = many(14, (i) => `scheduler_${String(i).padStart(2, '0')}`)
const VAES = many(18, (i) => `vae_${String(i).padStart(2, '0')}.safetensors`)

async function boot(page: Page, height: number) {
  await page.setViewportSize({ width: 1100, height: 800 })
  await bootWithFakeComfy(page, { checkpoints: CHECKPOINTS, loras: [], vaes: VAES, samplers: SAMPLERS, schedulers: SCHEDULERS, imageModel: CHECKPOINTS[0] })
  await openImageExpert(page)
  // A tiling window manager hands the app a short window.
  await page.setViewportSize({ width: 1100, height })
}

/** The open list and its trigger in window pixels, once the open animation has settled. */
async function measure(page: Page, trigger: Locator) {
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await expect.poll(() => list.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).opacity)).toBe('1')
  const t = await trigger.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } })
  return list.evaluate((el, t) => {
    const m = (el.parentElement as HTMLElement).getBoundingClientRect()
    return {
      top: m.top, bottom: m.bottom, left: m.left, right: m.right,
      gap: m.bottom <= t.top + 1 ? t.top - m.bottom : m.top - t.bottom,
      width: window.innerWidth, height: window.innerHeight,
      rows: el.querySelectorAll('[role="option"]').length,
      scrolls: el.scrollHeight > el.clientHeight,
    }
  }, t)
}

/** Opens the list, checks that it lies inside the window on its trigger, and picks a row at
 *  its far end: the last one, or the one named. */
async function opensInsideTheWindow(page: Page, trigger: Locator, what: string, row?: RegExp) {
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const m = await measure(page, trigger)
  if (process.env.LU_SHOTS) await page.screenshot({ path: `${process.env.LU_SHOTS}/short-window-${what.replaceAll(' ', '-')}-${process.env.LU_SHOT_TAG ?? 'after'}.png` })
  expect(m.rows, `${what}: the list should be long enough to matter`).toBeGreaterThan(8)
  expect(m.top, `${what}: starts above the window`).toBeGreaterThanOrEqual(0)
  expect(m.bottom, `${what}: runs ${Math.round(m.bottom - m.height)} px below the window`).toBeLessThanOrEqual(m.height)
  expect(m.left, `${what}: starts left of the window`).toBeGreaterThanOrEqual(0)
  expect(m.right, `${what}: runs past the right edge`).toBeLessThanOrEqual(m.width)
  expect(m.gap, `${what}: gap to its trigger`).toBeGreaterThanOrEqual(0)
  expect(m.gap, `${what}: gap to its trigger`).toBeLessThanOrEqual(8)
  const last = row ? page.getByRole('option', { name: row }) : page.getByRole('option').last()
  const name = (await last.innerText()).trim()
  await last.scrollIntoViewIfNeeded()
  // Not ratio 1: a fully visible row can report 0.9986 (subpixels).
  await expect(last).toBeInViewport({ ratio: 0.95 })
  await last.click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  return { name, scrolls: m.scrolls }
}

for (const height of [420, 300]) {
  test(`local lane, window ${height} px high: the lists of the advanced settings stay inside it`, async ({ page }) => {
    await boot(page, height)
    const drawer = page.locator('aside').filter({ hasText: 'Advanced settings' })
    const triggers = drawer.locator('button[aria-haspopup="listbox"]')
    // Sampler, scheduler and VAE at the least.
    await expect.poll(() => triggers.count()).toBeGreaterThanOrEqual(3)
    const count = await triggers.count()
    let long = 0
    for (let i = 0; i < count; i++) {
      const trigger = triggers.nth(i)
      const rows = await (async () => {
        await trigger.scrollIntoViewIfNeeded()
        await trigger.click()
        await expect(page.getByRole('listbox')).toBeVisible()
        const n = await page.getByRole('option').count()
        // Closed at its trigger: Escape would take the drawer along.
        await trigger.click()
        await expect(page.getByRole('listbox')).toHaveCount(0)
        return n
      })()
      if (rows <= 8) continue
      long++
      const picked = await opensInsideTheWindow(page, trigger, `drawer list ${i + 1} at ${height}`)
      await expect(trigger).toContainText(picked.name.replace('.safetensors', '').slice(0, 12))
    }
    expect(long, 'sampler, scheduler and VAE').toBeGreaterThanOrEqual(3)
  })

  test(`local lane, window ${height} px high: the model list in the composer stays inside it`, async ({ page }) => {
    await boot(page, height)
    await page.keyboard.press('Escape')
    await expect(page.getByText(/^LoRA stack/)).toHaveCount(0)
    // With the drawer closed the composer's model picker is the one list left.
    const picker = page.locator('button[aria-haspopup="listbox"]')
    await expect(picker).toHaveCount(1)
    await expect(picker).toContainText('sdxl checkpoint 00')
    // The last of the local models. Below it the list goes on with the Cloud models,
    // which open their own sheet and pick nothing.
    const picked = await opensInsideTheWindow(page, picker, `model list at ${height}`, /sdxl checkpoint 29/)
    expect(picked.scrolls, 'thirty models cannot fit, the list has to scroll').toBe(true)
    await expect(picker).toContainText('sdxl checkpoint 29')
  })
}
