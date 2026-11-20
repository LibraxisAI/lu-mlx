import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat } from './support/ui'

/**
 * The LU mark above the composer for a reader who scrolled up (the owner, roadmap).
 *
 * While the model works, the run status line stands at the end of the
 * transcript. Scrolled up, nothing on screen said the run was still going.
 * The mark alone now floats just above the composer for as long as the status
 * line is out of view and the run lives. It takes no room: the composer and
 * the transcript stay where they were.
 *
 * Run: CI=1 LU_E2E_PORT=5273 npx playwright test e2e/working-mark-above-composer.spec.ts
 * Pictures: LU_A15_SHOTS=<folder>
 */

const SHOTS = process.env.LU_A15_SHOTS

// Long enough to fill several screens, slow enough to scroll around in it.
const REPLY = Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1} of a long answer that keeps the model busy.`).join('\n\n')
const CHUNKS = 160
const GAP_MS = 110

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: REPLY,
    modelName: DEFAULT_MODEL_NAME,
    replyChunks: CHUNKS,
    replyChunkDelayMs: GAP_MS,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await openNewChat(page)
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const anchor = (page: Page) => page.getByTestId('working-anchor')
const mark = (page: Page) => page.getByTestId('working-beacon')
const composer = (page: Page) => page.locator('textarea').first()

/** How far the transcript is from its bottom edge, and whether it can scroll at all. */
async function transcript(page: Page) {
  return anchor(page).evaluate((el) => {
    let box = el.parentElement
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement
    if (!box) throw new Error('the status line has no scrolling transcript around it')
    const r = box.getBoundingClientRect()
    return {
      fromBottom: box.scrollHeight - box.scrollTop - box.clientHeight,
      overflow: box.scrollHeight - box.clientHeight,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
    }
  })
}

async function startLongRun(page: Page) {
  await composer(page).fill('Write a long answer.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(anchor(page)).toBeVisible({ timeout: 20_000 })
  // Scrolling up only means something once there is more than one screen.
  await expect.poll(async () => (await transcript(page)).overflow, { timeout: 20_000 }).toBeGreaterThan(600)
}

async function scrollUp(page: Page) {
  const t = await transcript(page)
  await page.mouse.move((t.left + t.right) / 2, (t.top + t.bottom) / 2)
  await page.mouse.wheel(0, -500)
  await expect.poll(async () => (await transcript(page)).fromBottom).toBeGreaterThan(200)
}

test('the mark comes when the reader scrolls up, goes at the bottom, and goes when the run ends', async ({ page }) => {
  await boot(page)
  await startLongRun(page)

  // Following the run: the status line is on screen, the mark is not.
  await expect(mark(page)).toHaveCount(0)
  const composerBefore = await composer(page).boundingBox()
  await shot(page, '01-following-no-mark')

  await scrollUp(page)
  await expect(mark(page)).toBeVisible()
  await expect(anchor(page)).not.toBeInViewport()
  await shot(page, '02-scrolled-up-mark-above-composer')

  // Just above the composer, inside the transcript, never on the prompt window.
  const m = (await mark(page).boundingBox())!
  const c = (await composer(page).boundingBox())!
  const t = await transcript(page)
  expect(m.y + m.height).toBeLessThanOrEqual(t.bottom + 0.5)
  expect(m.y + m.height).toBeLessThanOrEqual(c.y)
  expect(t.bottom - (m.y + m.height)).toBeLessThan(32)
  // Small: 1.75rem at the app's root size, well under a line of buttons.
  expect(m.width).toBeLessThanOrEqual(40)
  expect(m.height).toBeLessThanOrEqual(40)
  // The sign alone.
  expect((await mark(page).innerText()).trim()).toBe('')
  await expect(mark(page).getByTestId('status-glyph')).toHaveCount(1)
  // Nothing moved to make room for it.
  expect(c).toEqual(composerBefore)

  // A click goes back down; at the bottom the mark is gone.
  await mark(page).click()
  await expect(mark(page)).toHaveCount(0)
  await expect(anchor(page)).toBeInViewport()
  expect((await transcript(page)).fromBottom).toBeLessThan(100)

  // Every time the reader scrolls up, not only the first.
  await scrollUp(page)
  await expect(mark(page)).toBeVisible()

  // Scrolling back by hand hides it as well.
  await page.mouse.wheel(0, 100_000)
  await expect(mark(page)).toHaveCount(0)
  await scrollUp(page)
  await expect(mark(page)).toBeVisible()

  // The run ends while the reader is still up there: the mark leaves with it.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 60_000 })
  await expect(anchor(page)).toHaveCount(0)
  await expect(mark(page)).toHaveCount(0)
  expect((await transcriptAfterRun(page)).fromBottom).toBeGreaterThan(200)
  expect(await composer(page).boundingBox()).toEqual(composerBefore)
  await shot(page, '03-run-over-no-mark')
})

/** After the run the status line is gone, so the transcript is found from the composer side. */
async function transcriptAfterRun(page: Page) {
  return page.getByRole('main').evaluate((main) => {
    const boxes = Array.from(main.querySelectorAll<HTMLElement>('div')).filter(
      (el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight - el.clientHeight > 600,
    )
    const box = boxes[0]
    if (!box) throw new Error('no scrolled transcript found')
    return { fromBottom: box.scrollHeight - box.scrollTop - box.clientHeight }
  })
}

test('in a narrow window the mark stays inside the transcript and above the composer', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 560 })
  await boot(page)
  await startLongRun(page)
  await scrollUp(page)
  await expect(mark(page)).toBeVisible()

  const m = (await mark(page).boundingBox())!
  const c = (await composer(page).boundingBox())!
  const t = await transcript(page)
  expect(m.x).toBeGreaterThanOrEqual(t.left)
  expect(m.x + m.width).toBeLessThanOrEqual(t.right)
  expect(m.y).toBeGreaterThanOrEqual(t.top)
  expect(m.y + m.height).toBeLessThanOrEqual(c.y)
  // No sideways scrolling because of it.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await shot(page, '04-narrow-640x560')
})

test('with reduced motion the mark stands still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await boot(page)
  await startLongRun(page)
  await scrollUp(page)
  await expect(mark(page)).toBeVisible()
  await expect(mark(page).getByTestId('status-glyph')).toHaveAttribute('data-motion', 'off')
  await shot(page, '05-reduced-motion')
})
