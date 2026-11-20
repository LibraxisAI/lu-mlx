import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { mockModelsAnswer } from './support/chat-catalogue'

/**
 * The quiet "Limited capacity" note of the Cloud model picker (3.0.6).
 *
 * GET /api/inference/v1/models may carry `limited_capacity: true` on a model
 * that all customers together can ask only a few times a minute. The picker
 * then writes two plain grey words after the name: no frame, no fill, no
 * colour, because it is a note and not a mark. A model without the field
 * carries nothing, and nothing of it appears at or above the chat input.
 *
 * Run: CI=1 LU_E2E_PORT=5601 npx playwright test e2e/cloud-model-picker-limited-capacity.spec.ts
 * Pictures, light and dark: add LU_E2E_SHOT_DIR=/path/to/folder
 */

const OUT = process.env.LU_E2E_SHOT_DIR
const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}
/** One short name and the longest one with a mark, so both layouts are seen. */
const LIMITED = ['Qwen 3.6 27B', 'DeepSeek V4 Flash 0731']

type Theme = 'dark' | 'light'

const trigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')
const note = (page: Page) => menu(page).locator('[data-note="limited-capacity"]')

async function boot(page: Page, theme: Theme, withField = true) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  if (theme === 'light') {
    await page.addInitScript(() => {
      const stored = JSON.parse(localStorage.getItem('chat-settings') || '{}')
      if (stored?.state?.settings) {
        stored.state.settings.theme = 'light'
        localStorage.setItem('chat-settings', JSON.stringify(stored))
      }
    })
  }
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  const answer = mockModelsAnswer()
  const data = answer.data.map((m) => (withField && LIMITED.includes(m.name) ? { ...m, limited_capacity: true } : m))
  await page.route('**/api/inference/v1/models', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...answer, data }) }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 30_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 30_000 })
}

async function openPicker(page: Page) {
  await trigger(page).click()
  await expect(menu(page)).toBeVisible()
  await expect.poll(() => menu(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
}

for (const theme of ['dark', 'light'] as const) {
  test(`the note stands behind the name as plain grey text, ${theme}`, async ({ page }) => {
    await boot(page, theme)
    await openPicker(page)

    await expect(note(page)).toHaveCount(LIMITED.length)
    for (const name of LIMITED) {
      const row = menu(page).getByRole('option').filter({ hasText: name }).first()
      await row.scrollIntoViewIfNeeded()
      const mine = row.locator('[data-note="limited-capacity"]')
      await expect(mine).toBeVisible()
      await expect(mine).toHaveText('Limited capacity')

      const look = await mine.evaluate((el) => {
        const s = getComputedStyle(el)
        const sheet = getComputedStyle(el.closest('.lu-picker')!)
        const name = el.closest('.lu-picker-row')!.querySelector('.lu-picker-name')!.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        const rowBox = el.closest('.lu-picker-row')!.getBoundingClientRect()
        return {
          border: s.borderTopWidth + s.borderRightWidth + s.borderBottomWidth + s.borderLeftWidth,
          background: s.backgroundColor,
          color: s.color,
          muted: sheet.getPropertyValue('--pk-t3').trim(),
          size: parseFloat(s.fontSize),
          nameSize: parseFloat(getComputedStyle(el.closest('.lu-picker-row')!.querySelector('.lu-picker-name')!).fontSize),
          behindOrUnder: r.left >= name.right - 1 || r.top >= name.bottom - 1,
          insideRow: r.left >= rowBox.left && r.right <= rowBox.right && r.top >= rowBox.top && r.bottom <= rowBox.bottom,
          cut: el.scrollWidth > el.clientWidth + 1,
        }
      })
      expect(look.border, 'no frame').toBe('0px0px0px0px')
      expect(look.background, 'no fill').toBe('rgba(0, 0, 0, 0)')
      // The picker's own muted grey, which is a grey: all three channels equal
      // within the tint of the ladder.
      const [r, g, b] = look.color.match(/\d+/g)!.map(Number)
      expect(Math.max(r, g, b) - Math.min(r, g, b), `a grey, got ${look.color}`).toBeLessThanOrEqual(24)
      expect(look.size, 'smaller than the name').toBeLessThan(look.nameSize)
      expect(look.behindOrUnder, 'after the name or under it').toBe(true)
      expect(look.insideRow, 'inside its row').toBe(true)
      expect(look.cut, 'not cut').toBe(false)
    }

    // A row without the field carries nothing.
    await expect(menu(page).getByRole('option').filter({ hasText: 'Llama 3.1 8B Turbo' }).first()
      .locator('[data-note="limited-capacity"]')).toHaveCount(0)

    if (OUT) {
      const first = menu(page).getByRole('option').filter({ hasText: LIMITED[0] }).first()
      await first.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${OUT}/limited-capacity-desktop-${theme}.png` })
      await menu(page).screenshot({ path: `${OUT}/limited-capacity-desktop-${theme}-panel.png` })
      await menu(page).getByTestId('model-picker-search').fill('deepseek v4')
      await page.waitForTimeout(300)
      await menu(page).screenshot({ path: `${OUT}/limited-capacity-desktop-${theme}-long-name-panel.png` })
      await menu(page).getByTestId('model-picker-search').fill('')
    }

    // Picking the model leaves the words in the list: nothing at or above the
    // chat input says them.
    await menu(page).getByRole('button', { name: new RegExp(LIMITED[0].replace(/\./g, '\\.')) }).click()
    await expect(menu(page)).toBeHidden()
    await expect(trigger(page)).toContainText(LIMITED[0])
    await expect(page.getByText('Limited capacity')).toHaveCount(0)
  })
}

test('in a small window neither the name nor the note is cut', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 })
  await boot(page, 'dark')
  await openPicker(page)
  const row = menu(page).getByRole('option').filter({ hasText: LIMITED[1] }).first()
  await row.scrollIntoViewIfNeeded()
  const m = await row.evaluate((el) => {
    const name = el.querySelector<HTMLElement>('.lu-picker-name')!
    const quiet = el.querySelector<HTMLElement>('[data-note="limited-capacity"]')!
    const box = el.getBoundingClientRect()
    const q = quiet.getBoundingClientRect()
    return {
      nameCut: name.scrollWidth > name.clientWidth + 1,
      noteInside: q.left >= box.left && q.right <= box.right && q.top >= box.top - 0.5 && q.bottom <= box.bottom + 0.5,
    }
  })
  expect(m.nameCut, 'the name is whole').toBe(false)
  expect(m.noteInside, 'the note is inside the row').toBe(true)
  if (OUT) await menu(page).screenshot({ path: `${OUT}/limited-capacity-desktop-dark-640x400-panel.png` })
})

test('a server that does not send the field shows no note', async ({ page }) => {
  await boot(page, 'dark', false)
  await openPicker(page)
  await expect(menu(page).getByRole('option').first()).toBeVisible()
  await expect(page.getByText('Limited capacity')).toHaveCount(0)
})
