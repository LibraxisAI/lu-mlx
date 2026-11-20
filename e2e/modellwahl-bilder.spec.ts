import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { mockModelsAnswer } from './support/chat-catalogue'

/**
 * Pictures of the built model pickers, for showing someone the result rather
 * than describing it. Nothing is asserted about the product here beyond what
 * a picture needs (the thing is on screen), so the spec skips unless a folder
 * is named:
 *
 *   CI=1 LU_E2E_PORT=5311 LU_E2E_SHOT_DIR=/path/to/folder npx playwright test e2e/modellwahl-bilder.spec.ts
 *
 * Each state is written twice: the whole window, and the menu alone
 * (`-nur-menue`).
 */

const OUT = process.env.LU_E2E_SHOT_DIR
test.skip(!OUT, 'set LU_E2E_SHOT_DIR to write the pictures')

const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}

type Theme = 'dark' | 'light'

async function setTheme(page: Page, theme: Theme) {
  if (theme === 'dark') return
  await page.addInitScript(() => {
    const key = 'chat-settings'
    const stored = JSON.parse(localStorage.getItem(key) || '{}')
    if (stored?.state?.settings) {
      stored.state.settings.theme = 'light'
      localStorage.setItem(key, JSON.stringify(stored))
    }
  })
}

async function bootIntoCloud(page: Page, theme: Theme, extra: Record<string, unknown> = {}) {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  await setTheme(page, theme)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true, ...extra })
  await page.route('**/api/inference/v1/models', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockModelsAnswer()) }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 30_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 30_000 })
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')

async function openChatPicker(page: Page) {
  await trigger(page).click()
  await expect(menu(page)).toBeVisible()
  await expect.poll(() => menu(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
}

async function shoot(page: Page, name: string, part = menu(page)) {
  // Let the open animation and the fonts settle.
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  await part.screenshot({ path: `${OUT}/${name}-nur-menue.png` })
}

for (const theme of ['dark', 'light'] as const) {
  test(`cloud picker, ${theme}`, async ({ page }) => {
    await bootIntoCloud(page, theme)
    await openChatPicker(page)
    await expect(menu(page).getByRole('option').first()).toBeVisible()
    await shoot(page, `cloud-${theme}-kein-modell`)

    // With a model picked: the accent bar on the selected row, no hint line.
    await menu(page).getByRole('button', { name: /Qwen 3\.6 27B/ }).click()
    await openChatPicker(page)
    await shoot(page, `cloud-${theme}`)

    // The rates of one model.
    await menu(page).getByRole('option').filter({ hasText: 'Qwen 3.6 27B' }).getByRole('button', { name: 'Credit rates' }).click()
    await expect(page.getByTestId('model-rate-popover')).toBeVisible()
    await shoot(page, `cloud-${theme}-raten`)
    await page.keyboard.press('Escape')

    // A search and a pressed tag.
    await page.getByTestId('model-picker-search').fill('qwen 3')
    await shoot(page, `cloud-${theme}-suche`)
    await page.getByTestId('model-picker-search').fill('')
    await menu(page).locator('[data-chip="marked"]').click()
    await shoot(page, `cloud-${theme}-tag`)
  })
}

test('cloud picker in a small window', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 })
  await bootIntoCloud(page, 'dark')
  await openChatPicker(page)
  await shoot(page, 'cloud-dark-kleines-fenster-640x400')
})

for (const theme of ['dark', 'light'] as const) {
  test(`local list with the LM Studio line, ${theme}`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, {
      ...OPTS,
      ollamaModels: ['qwen3:14b', 'gemma3:12b', 'llama3.1:8b', 'hermes3:8b', 'mistral-nemo:12b', 'deepseek-r1:14b'],
    } as TauriMockOptions)
    // LM Studio is on disk, its server is off.
    await page.addInitScript(() => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown, o: unknown) => Promise<unknown> } }
      const before = w.__TAURI_INTERNALS__.invoke
      w.__TAURI_INTERNALS__.invoke = (cmd, args, o) => {
        if (cmd === 'lmstudio_server_status') {
          return Promise.resolve({ running: false, port: 1234, lms_present: true, models_detected: true, model_count: 7 })
        }
        return before(cmd, args, o)
      }
    })
    await seedOnboardingDone(page)
    await setTheme(page, theme)
    await routeCloud(page, { license: 'none', access: false, mediaLive: true })
    await page.goto('/')
    await page.getByRole('button', { name: /New Chat/i }).first().click()
    await openChatPicker(page)
    await expect(page.getByTestId('lmstudio-status-line')).toBeVisible()
    await shoot(page, `lokal-lmstudio-zeile-${theme}`)
  })
}

// The model select in Create: not a new picker, the same app. Same sheet,
// hairline, one-line group heads, row height, tags and accent bar.
async function openCreate(page: Page, kind: 'Image' | 'Video') {
  // Inside Create a second button reads "Create": the one that starts a run.
  const radio = page.getByRole('radio', { name: kind, exact: true })
  if (!(await radio.isVisible())) await page.getByRole('button', { name: /^Create$/ }).first().click()
  await radio.click()
  await page.locator('button[aria-haspopup="listbox"]').first().click()
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await expect.poll(() => list.evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).opacity)).toBe('1')
  return list.locator('xpath=..')
}

for (const theme of ['dark', 'light'] as const) {
  test(`Create select, cloud, ${theme}`, async ({ page }) => {
    await bootIntoCloud(page, theme, { tierCatalog: true })
    const imageMenu = await openCreate(page, 'Image')
    await expect(imageMenu.locator('.lu-picker-head').first()).toBeVisible()
    await shoot(page, `create-cloud-bild-${theme}`, imageMenu)
    await page.keyboard.press('Escape')
    const videoMenu = await openCreate(page, 'Video')
    await shoot(page, `create-cloud-video-${theme}`, videoMenu)
  })
}

test('Create select, local models', async ({ page }) => {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'none', access: false, mediaLive: true })
  await page.goto('/')
  const menu = await openCreate(page, 'Image')
  await shoot(page, 'create-lokal-bild-dark', menu)
})
