import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { MOCK_CHAT_CATALOGUE, mockModelsAnswer } from './support/chat-catalogue'

/**
 * The model picker in Cloud mode since 3.0.5, in the running app.
 *
 * 05.10.2026: grouped by family, a search on top, chips that narrow the
 * list, a keyboard that works from the search field, and per row a tiny
 * question mark that opens the model's credit rates per one million tokens.
 * And the lesson of GitHub #149: the app is zoomed by 1.15, and a menu that
 * does its own sums ends up outside the window. So the menu and the rate
 * popover are measured here in a real layout, in a large and in small windows.
 *
 * Run: CI=1 LU_E2E_PORT=5311 npx playwright test e2e/cloud-model-picker-search-and-tags.spec.ts
 */

const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}
const TOTAL = MOCK_CHAT_CATALOGUE.length
const MARKED = MOCK_CHAT_CATALOGUE.filter((m) => m.unfiltered === 'full').length

const trigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')
const search = (page: Page) => page.getByTestId('model-picker-search')
const rows = (page: Page) => menu(page).getByRole('option')
const count = (page: Page) => page.getByTestId('model-picker-count')
const cursorName = (page: Page) => menu(page).locator('[role="option"][data-cursor="true"] .lu-picker-name')

async function bootIntoCloud(page: Page) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.route('**/api/inference/v1/models', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockModelsAnswer()) }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
  await expect(trigger(page)).toContainText('Choose a model')
}

async function openPicker(page: Page) {
  await trigger(page).click()
  await expect(menu(page)).toBeVisible()
  // The open animation scales the menu; measure and click once it has settled.
  await expect.poll(() => menu(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await expect(rows(page)).toHaveCount(TOTAL)
}

/** A box completely inside the window, in visible pixels. */
async function expectInsideWindow(page: Page, testId: string) {
  const m = await page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: window.innerWidth, h: window.innerHeight }
  })
  expect(m.top, `${testId} starts above the window`).toBeGreaterThanOrEqual(0)
  expect(m.left, `${testId} starts left of the window`).toBeGreaterThanOrEqual(0)
  expect(m.bottom, `${testId} runs ${Math.round(m.bottom - m.h)} px below the window`).toBeLessThanOrEqual(m.h)
  expect(m.right, `${testId} runs ${Math.round(m.right - m.w)} px past the right edge`).toBeLessThanOrEqual(m.w)
  return m
}

test('open, search, narrow by a tag, pick with the keyboard', async ({ page }) => {
  await bootIntoCloud(page)
  await openPicker(page)

  // The whole catalogue under one-line family heads, the search has the keyboard.
  await expect(menu(page)).toHaveAttribute('data-picker', 'cloud')
  await expect(count(page)).toHaveText(`${TOTAL} cloud models`)
  await expect(menu(page).locator('.lu-picker-head b').first()).toHaveText('Qwen')
  await expect(menu(page).locator('.lu-picker-head b').last()).toHaveText('Other')
  await expect(search(page)).toBeFocused()
  await expect(page.getByTestId('picker-choose-a-model')).toHaveText('Choose a model to send your message.')

  // A head is one line and stays at the top of the list while its rows scroll.
  const head = menu(page).locator('[data-family="Qwen"]')
  const list = menu(page).getByRole('listbox')
  const before = await head.boundingBox()
  await list.evaluate((el) => { el.scrollTop = 120 })
  const after = await head.boundingBox()
  expect(Math.abs(after!.y - before!.y), 'the head sticks while the list scrolls').toBeLessThanOrEqual(1)
  expect(before!.height).toBeLessThanOrEqual(22 * 1.15 + 1)
  await list.evaluate((el) => { el.scrollTop = 0 })

  // Typing narrows, the heads give way to a hit list, the hit is underlined.
  await page.keyboard.type('qwen 3.6')
  await expect(rows(page)).toHaveCount(2)
  await expect(menu(page).locator('.lu-picker-head')).toHaveCount(0)
  await expect(count(page)).toHaveText(`2 of ${TOTAL}`)
  await expect(rows(page).first().locator('mark').first()).toHaveText('Qwen')

  // Escape empties the search first, the menu stays.
  await page.keyboard.press('Escape')
  await expect(search(page)).toHaveValue('')
  await expect(menu(page)).toBeVisible()
  await expect(rows(page)).toHaveCount(TOTAL)

  // A tag narrows to the measured models, a second one narrows further.
  const marked = menu(page).locator('[data-chip="marked"]')
  await expect(marked).toHaveText(`No Filter ${MARKED}`)
  await marked.click()
  await expect(marked).toHaveAttribute('aria-pressed', 'true')
  await expect(rows(page)).toHaveCount(MARKED)
  await expect(menu(page).locator('[role="option"] [data-mark="unfiltered"]')).toHaveCount(MARKED)
  await menu(page).locator('[data-chip="vision"]').click()
  const both = MOCK_CHAT_CATALOGUE.filter((m) => m.unfiltered === 'full' && m.vision).length
  await expect(rows(page)).toHaveCount(both)
  await menu(page).locator('[data-chip="vision"]').click()
  await marked.click()
  await expect(rows(page)).toHaveCount(TOTAL)

  // Nothing that matches is said in words.
  await search(page).fill('no such model')
  await expect(page.getByTestId('model-picker-no-match')).toHaveText('No models match. Clear the search or a tag.')
  await search(page).fill('')

  // The keyboard: arrows move the cursor from the search field, Enter picks.
  await search(page).fill('deepseek')
  await expect(cursorName(page)).toHaveText('DeepSeek V3.2')
  await page.keyboard.press('ArrowDown')
  const second = await cursorName(page).innerText()
  expect(second).not.toBe('DeepSeek V3.2')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await expect(trigger(page)).toContainText(second)

  // Reopened, the picked row is the selected one and the hint is gone.
  await openPicker(page)
  await expect(menu(page).locator('[role="option"][aria-selected="true"] .lu-picker-name')).toHaveText(second)
  await expect(page.getByTestId('picker-choose-a-model')).toHaveCount(0)
  // Escape with an empty search closes, and the trigger has the keyboard back.
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(trigger(page)).toBeFocused()
})

test('a click on a row picks that model', async ({ page }) => {
  await bootIntoCloud(page)
  await openPicker(page)
  await menu(page).getByRole('button', { name: /Qwen 3\.6 27B/ }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(trigger(page)).toContainText('Qwen 3.6 27B')
})

test('the question mark shows credit rates per one million tokens, and never money', async ({ page }) => {
  await bootIntoCloud(page)
  await openPicker(page)

  const row = rows(page).filter({ hasText: 'Qwen 3.6 27B' })
  const model = MOCK_CHAT_CATALOGUE.find((m) => m.label === 'Qwen 3.6 27B')!
  await row.getByRole('button', { name: 'Credit rates' }).click()
  const pop = page.getByTestId('model-rate-popover')
  await expect(pop).toBeVisible()
  await expect(pop.locator('h4')).toHaveText('Credits per 1M tokens')
  await expect(pop.locator('[data-rate="input"]')).toHaveText(model.rates![0].toLocaleString('en-US'))
  await expect(pop.locator('[data-rate="output"]')).toHaveText(model.rates![1].toLocaleString('en-US'))
  expect(await pop.innerText()).not.toMatch(/[$€£]|usd|eur|dollar|price|cost/i)
  await expectInsideWindow(page, 'model-rate-popover')
  // It hangs on its question mark, a few pixels away and not a hand's width.
  const gap = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="model-rate-popover"]')!.getBoundingClientRect()
    const b = document.querySelector('.lu-picker-rate-btn[aria-expanded="true"]')!.getBoundingClientRect()
    const vertical = p.top >= b.bottom ? p.top - b.bottom : b.top - p.bottom
    return { vertical, right: Math.abs(p.right - b.right) }
  })
  expect(gap.vertical).toBeGreaterThanOrEqual(0)
  expect(gap.vertical).toBeLessThanOrEqual(8)
  expect(gap.right).toBeLessThanOrEqual(2)
  // The menu is still open and nothing was picked.
  await expect(menu(page)).toBeVisible()
  await expect(trigger(page)).toContainText('Choose a model')
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await expect(menu(page)).toBeVisible()

  // Focus plus Enter opens it too.
  await row.getByRole('button', { name: 'Credit rates' }).focus()
  await page.keyboard.press('Enter')
  await expect(pop).toBeVisible()
  await expect(trigger(page)).toContainText('Choose a model')
  await page.keyboard.press('Escape')

  // A Flash model on a paid plan draws nothing, and says so there.
  const flash = MOCK_CHAT_CATALOGUE.find((m) => m.flash)!
  await rows(page).filter({ hasText: flash.label }).first().getByRole('button', { name: 'Credit rates' }).click()
  await expect(pop).toHaveText('No credits on your plan, up to 2,000,000 tokens per day.')
  await page.keyboard.press('Escape')

  // The server sent no rates for this one: no question mark, nothing invented.
  const bare = rows(page).filter({ hasText: 'Kimi K3' })
  await expect(bare).toHaveCount(1)
  await expect(bare.getByRole('button', { name: 'Credit rates' })).toHaveCount(0)
  await expect(bare.locator('[data-context]')).toHaveText('')
})

for (const size of [
  { width: 1280, height: 800 },
  { width: 900, height: 420 },
  { width: 560, height: 520 },
  { width: 640, height: 400 },
]) {
  test(`the menu and its rate popover stay inside a ${size.width} x ${size.height} window`, async ({ page }) => {
    await page.setViewportSize(size)
    await bootIntoCloud(page)
    await openPicker(page)
    const m = await expectInsideWindow(page, 'model-picker-menu')
    // On its trigger: a few pixels of gap, above or below.
    const t = await trigger(page).boundingBox()
    const gap = m.bottom <= t!.y + 1 ? t!.y - m.bottom : m.top - (t!.y + t!.height)
    expect(gap, 'gap between trigger and menu').toBeGreaterThanOrEqual(0)
    expect(gap, 'gap between trigger and menu').toBeLessThanOrEqual(10)
    // Head and foot are always there, the list between them scrolls.
    await expect(search(page)).toBeInViewport()
    await expect(count(page)).toBeInViewport()
    // The last model of the catalogue can be reached and picked.
    const last = rows(page).last()
    await last.scrollIntoViewIfNeeded()
    await expectInsideWindow(page, 'model-picker-menu')
    const rate = last.getByRole('button', { name: 'Credit rates' })
    if (await rate.count()) {
      await rate.click()
      await expectInsideWindow(page, 'model-rate-popover')
      await page.keyboard.press('Escape')
    }
    const name = await last.locator('.lu-picker-name').innerText()
    await last.locator('.lu-picker-pick').click()
    await expect(menu(page)).toHaveCount(0)
    await expect(trigger(page)).toContainText(name.slice(0, 8))
  })
}
