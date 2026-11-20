import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'
import { MOCK_CHAT_CATALOGUE, mockModelsAnswer } from './support/chat-catalogue'

/**
 * The two marks of a cloud model row, in the running app (09.10.2026).
 *
 * The measured mark reads "No Filter" and steps back: a grey word in a
 * hairline. The models the cloud serves from one fixed upstream and marks
 * `unrestricted` carry "Uncensored" at the same place, in the accent. There is
 * no badge of its own: the coloured word is the difference, in the picker, in
 * its group head and in the command palette. The app shows the model's own
 * published name (`native_name`), never the neutral one of the web app.
 *
 * The listing below is the shape the models route sends with a key set
 * (the web app, app/api/inference/v1/models/route.ts).
 *
 * Run: CI=1 LU_E2E_PORT=5431 npx playwright test e2e/uncensored-mark.spec.ts
 * Pictures: LU_E2E_SHOTS=<folder> writes light and dark views there.
 */

const OPTS: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'windows',
}
const SHOTS = process.env.LU_E2E_SHOTS

interface Direct { id: string; name: string; native_name?: string; vision?: boolean; think: string; context: number; rates: [number, number]; ladder?: string[] }
const DIRECT: Direct[] = [
  { id: 'direct/v-1.2', name: 'Unfiltered 1.2', native_name: 'Venice Uncensored 1.2', vision: true, think: 'never', context: 128000, rates: [13637, 61364] },
  { id: 'direct/role-play', name: 'Unfiltered Role Play', native_name: 'Venice Role Play Uncensored', think: 'never', context: 128000, rates: [34091, 136364] },
  { id: 'direct/gemma-4', name: 'Gemma 4 Unfiltered', native_name: 'Gemma 4 Uncensored', vision: true, think: 'never', context: 256000, rates: [11080, 34091] },
  { id: 'direct/glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic', think: 'toggle', context: 200000, rates: [4773, 27273], ladder: ['low', 'medium', 'high'] },
  { id: 'direct/aion-3.0', name: 'Aion 3.0', think: 'toggle', context: 128000, rates: [255682, 511364] },
  { id: 'direct/abliterated-large-v2', name: 'Abliterated Large V2', think: 'always', context: 1000000, rates: [204546, 340910] },
]
const SHOWN = DIRECT.map((m) => m.native_name ?? m.name)
const MEASURED = MOCK_CHAT_CATALOGUE.filter((m) => m.unfiltered === 'full').length
const TOTAL = MOCK_CHAT_CATALOGUE.length + DIRECT.length

function listing() {
  const base = mockModelsAnswer()
  return {
    ...base,
    data: [
      ...base.data,
      ...DIRECT.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: 'lu-labs',
        name: m.name,
        ...(m.native_name ? { native_name: m.native_name } : {}),
        context_length: m.context,
        max_output_length: 8192,
        input_modalities: m.vision ? ['text', 'image'] : ['text'],
        think: m.think,
        supports_tools: true,
        unrestricted: true,
        credit_rates: { input_per_million: m.rates[0], output_per_million: m.rates[1] },
        ...(m.ladder ? { reasoning_effort_levels: m.ladder, reasoning_effort_default: m.ladder[0] } : {}),
      })),
    ],
  }
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })
const menu = (page: Page) => page.getByTestId('model-picker-menu')
const rows = (page: Page) => menu(page).getByRole('option')

async function boot(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript(tauriMockInit, OPTS)
  await seedOnboardingDone(page)
  if (theme === 'light') {
    await page.addInitScript(() => {
      const key = 'chat-settings'
      const stored = JSON.parse(localStorage.getItem(key) || '{}')
      if (stored?.state?.settings) {
        stored.state.settings.theme = 'light'
        localStorage.setItem(key, JSON.stringify(stored))
      }
    })
  }
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.route('**/api/inference/v1/models', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listing()) }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 20_000 })
}

async function openPicker(page: Page) {
  await trigger(page).click()
  await expect(menu(page)).toBeVisible()
  await expect.poll(() => menu(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await expect(rows(page)).toHaveCount(TOTAL)
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** WCAG contrast of a text colour on what is painted behind it. The tag's own
 *  tint is a translucent layer, so it is composited over the first opaque
 *  ancestor before the ratio is taken. */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const parse = (c: string): [number, number, number, number] => {
      const srgb = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/)
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]
    }
    const layers: [number, number, number, number][] = []
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor)
      if (bg[3] > 0) layers.push(bg)
      if (bg[3] >= 1) break
    }
    let back: [number, number, number] = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? [0, 0, 0] : [255, 255, 255]
    for (const [r, g, b, a] of layers.reverse()) {
      back = [r * a + back[0] * (1 - a), g * a + back[1] * (1 - a), b * a + back[2] * (1 - a)]
    }
    const text = parse(getComputedStyle(el).color)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const a = lum(text), b = lum(back)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`the two marks in the cloud picker, ${theme}`, async ({ page }) => {
    await boot(page, theme)
    await openPicker(page)

    // One group under the one word, in front of every lineage, with the
    // published names. The neutral names of the web app are nowhere.
    const heads = menu(page).locator('.lu-picker-head b')
    await expect(heads.first()).toHaveText('Uncensored')
    await expect(heads.nth(1)).toHaveText('Qwen')
    for (let i = 0; i < SHOWN.length; i++) {
      await expect(rows(page).nth(i).locator('.lu-picker-name')).toHaveText(SHOWN[i])
    }
    await expect(menu(page).getByText(/Unfiltered/)).toHaveCount(0)

    // The statement: the word at the place of the mark, in the accent tag.
    const statements = menu(page).locator('[data-mark="statement"]')
    await expect(statements).toHaveCount(DIRECT.length)
    await expect(statements.first()).toHaveText('Uncensored')
    await expect(statements.first()).toHaveClass(/lu-picker-tag/)
    await expect(statements.first()).toHaveClass(/is-statement/)
    await expect(statements.first()).toHaveAttribute('title', /Released by its makers to answer without refusing, and never swapped/)
    // The measured mark: the new word, quiet, and on exactly the measured rows.
    const measured = menu(page).locator('[data-mark="unfiltered"]')
    await expect(measured).toHaveCount(MEASURED)
    await expect(measured.first()).toHaveText('No Filter')
    await expect(measured.first()).not.toHaveClass(/is-statement|is-accent|is-bright/)
    await expect(menu(page).getByText(/No refusals/i)).toHaveCount(0)
    // Never both on one row.
    for (let i = 0; i < DIRECT.length; i++) await expect(rows(page).nth(i).locator('[data-mark]')).toHaveCount(1)

    // The colour is the difference: the statement is drawn in the accent, the
    // measured mark in grey, and both stay readable.
    const colours = await page.evaluate(() => {
      const of = (sel: string) => getComputedStyle(document.querySelector(sel)!)
      return {
        statement: of('[data-mark="statement"]').color,
        measured: of('[data-mark="unfiltered"]').color,
        weight: of('[data-mark="statement"]').fontWeight,
        measuredWeight: of('[data-mark="unfiltered"]').fontWeight,
      }
    })
    expect(colours.statement).not.toBe(colours.measured)
    expect(Number(colours.weight)).toBeGreaterThan(Number(colours.measuredWeight))
    const statementContrast = await contrastOf(page, '[data-mark="statement"]')
    const measuredContrast = await contrastOf(page, '[data-mark="unfiltered"]')
    console.log(`contrast ${theme}: statement ${statementContrast.toFixed(2)}, measured ${measuredContrast.toFixed(2)}, colours ${JSON.stringify(colours)}`)
    expect(statementContrast, 'the statement on its row').toBeGreaterThanOrEqual(4.5)
    expect(measuredContrast, 'the measured mark on its row').toBeGreaterThanOrEqual(3)
    await shoot(page, `picker-${theme}`)

    // The chip narrows to every marked row, of both kinds, and counts them.
    const chip = menu(page).locator('[data-chip="marked"]')
    await expect(chip).toHaveText(`No Filter ${MEASURED + DIRECT.length}`)
    await chip.click()
    await expect(rows(page)).toHaveCount(MEASURED + DIRECT.length)
    await expect(statements).toHaveCount(DIRECT.length)
    await shoot(page, `picker-${theme}-chip`)
    await chip.click()

    // The search finds the group by its word.
    await page.getByTestId('model-picker-search').fill('uncensored')
    await expect(rows(page)).toHaveCount(DIRECT.length)
    await shoot(page, `picker-${theme}-search`)

    // Picked: the trigger shows the published name.
    await rows(page).filter({ hasText: 'Venice Uncensored 1.2' }).click()
    await expect(trigger(page)).toContainText('Venice Uncensored 1.2')
    await shoot(page, `picked-${theme}`)

    // The command palette: the same word at the same kind of place.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lu-command-palette')))
    const palette = page.getByRole('dialog')
    await palette.getByRole('combobox').or(palette.getByRole('textbox')).first().fill('use gemma 4')
    const entry = palette.getByRole('option').filter({ hasText: 'Use Gemma 4 Uncensored' })
    await expect(entry).toBeVisible()
    await expect(entry.locator('[data-mark="statement"]')).toHaveText('Uncensored')
    const measuredEntry = palette.getByRole('option').filter({ hasText: /gemma-4-31B-it-turbo/i })
    await expect(measuredEntry.locator('[data-mark="unfiltered"]')).toHaveText('No Filter')
    await shoot(page, `palette-${theme}`)
  })
}
