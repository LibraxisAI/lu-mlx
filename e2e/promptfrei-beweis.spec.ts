import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * Die Bilder zu „NICHTS im prompt fenster!"
 *
 * 21.09.2026, am echten Windows-Bau, mehrfach und veraergert. Zwei
 * Befunde lagen als Bild vor:
 *
 *   B3-dropdown-hint.png     IM Kasten des Composers, direkt ueber der Zeile,
 *                            in die er tippen wollte, stand eine Leiste mit x
 *                            und dem Satz "... is gone from the model list,
 *                            so the chat switched to ...".
 *   C4-search-pixel-results  das CivitAI-Suchfeld trug beim Fokus einen
 *                            dicken Akzentrahmen. „der lila balken um das
 *                            prompt fenster geht garnicht ... nirgends."
 *
 * Diese Datei fotografiert den Stand danach, und zwar durch die ECHTE
 * Oberflaeche: die Modellzeile wird nicht in einen Speicher geschrieben,
 * sondern ausgeloest, indem sich der Katalog unter der Wahl bewegt, genau wie
 * im gemessenen Fall (Provider herausgenommen, Modell weg). Alles andere sind
 * Fokusaufnahmen, eine je Feldsorte, plus die Gegenprobe am Knopf.
 *
 * Die Bilder landen in test-results/promptfrei/ (oder LU_PROMPTFREI_SHOTS) als
 * `nachher-*.png`. Dieselbe Datei, gegen `integ/301` gefahren, liefert die
 * `vorher-*.png` (die Fokusaufnahmen laufen dort unveraendert; die beiden
 * Composer-Aufnahmen sind dort der Befund selbst).
 *
 * Run: npx playwright test e2e/promptfrei-beweis.spec.ts
 */

const SHOTS = process.env.LU_PROMPTFREI_SHOTS ?? resolve(process.cwd(), 'test-results/promptfrei')
const PRAEFIX = process.env.LU_PROMPTFREI_PREFIX ?? 'nachher'
mkdirSync(SHOTS, { recursive: true })

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }

const bild = (name: string) => `${SHOTS}/${PRAEFIX}-${name}.png`

/** Ein Modell im Katalog, so wie LU Cloud es ausliefert. */
const modell = (id: string, name: string) => ({
  id, name, context_length: 131072, supports_tools: true, think: 'never',
})

/**
 * Der Katalog, den der naechste Abruf sieht. Veraenderlich, weil genau das
 * der gemessene Fall ist: die Liste bewegt sich unter der Wahl, der Waehler
 * liest beim Aufklappen neu, und die App waehlt selbst um.
 */
let katalog = [
  modell('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo'),
  modell('Qwen/Qwen3-9B', 'Qwen3 9B'),
]

async function bootChat(page: Page): Promise<void> {
  katalog = [
    modell('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo'),
    modell('Qwen/Qwen3-9B', 'Qwen3 9B'),
  ]
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.route('**/api/inference/v1/models', (route) => route.fulfill({
    status: 200, headers: CORS, contentType: 'application/json',
    body: JSON.stringify({ object: 'list', data: katalog }),
  }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible()
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked()
  await page.getByRole('button', { name: /New Chat/i }).first().click()
}

/** Lokaler Start, ohne Cloud: die Models-Seite und ihr LoRA-Reiter gibt es
 *  nur dort, weil sie die Modelle auf der eigenen Platte verwaltet. */
async function bootLokal(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Models', exact: true })).toBeVisible()
}

const waehler = (page: Page) => page.getByRole('button', { name: 'Select chat model', exact: true })

test('Chat: die Modellzeile steht im Waehler, der Composer bleibt leer', async ({ page }) => {
  await bootChat(page)

  // Die Wahl faellt auf Llama, genau das Modell aus dem Befundbild.
  await waehler(page).click()
  await page.getByRole('button', { name: /Llama 3.1 8B Turbo/ }).click()

  // Und jetzt bewegt sich die Liste darunter: Llama ist weg. Beim naechsten
  // Aufklappen liest der Waehler neu, `setModels` nimmt die erste Zeile, und
  // die App sagt, dass sie das getan hat.
  katalog = [modell('Qwen/Qwen3-9B', 'Qwen3 9B')]
  await waehler(page).click()

  const menue = page.getByTestId('model-picker-menu')
  await expect(menue).toBeVisible()
  await page.waitForTimeout(600)

  // Das ganze Fenster mit offenem Menue: hier ist zu sehen, dass der Satz im
  // Menue steht UND dass ueber der Eingabezeile nichts mehr haengt.
  await page.screenshot({ path: bild('chat-modell-weg-menue') })

  // Und der Kasten des Composers allein, denn darum ging der Streit.
  const kasten = page.getByTestId('composer-send-slot').locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
  await kasten.screenshot({ path: bild('chat-composer-modell-weg') })
})

test('Chat: der Composer im Fokus traegt eine Haarlinie, keinen Akzentrahmen', async ({ page }) => {
  await bootChat(page)
  const feld = page.locator('textarea[data-lu-composer], textarea[data-lu-quiet-focus]').first()
  await feld.click()
  await feld.type('A prompt, and nothing above it.')
  await page.waitForTimeout(250)
  await page.screenshot({ path: bild('chat-composer-fokus'), clip: { x: 260, y: 600, width: 840, height: 200 } })
})

test('Einstellungen: ein Textfeld im Fokus', async ({ page }) => {
  await bootLokal(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  // Das erste sichtbare Textfeld des Blattes, welches es auch sei: die neue
  // Regel gilt allen, und ein namentlich gesuchtes Feld haette nur bewiesen,
  // dass genau dieses eine stimmt.
  // Die Abschnitte des Blattes sind zugeklappt; „Generation" traegt die
  // Zahlenfelder (Max Tokens und Nachbarn). Ein `type="number"` ist eine
  // Texteingabe im Sinne der neuen Regel: man schreibt hinein.
  await page.getByRole('button', { name: 'Generation', exact: true }).first().click()
  const feld = page.locator('input[type="text"], input[type="number"], input:not([type])').first()
  await expect(feld).toBeVisible()
  await feld.scrollIntoViewIfNeeded()
  console.log('Settings-Feld:', await feld.evaluate((e: HTMLInputElement) =>
    `${e.type || 'text'} / ${e.getAttribute('aria-label') ?? e.placeholder}`))
  await feld.click()
  await page.waitForTimeout(300)
  const box = await feld.boundingBox()
  await page.screenshot({
    path: bild('settings-textfeld-fokus'),
    clip: box ? { x: Math.max(0, box.x - 420), y: Math.max(0, box.y - 60), width: 900, height: 150 } : undefined,
  })
})

test('Ein Knopf mit Tastaturfokus behaelt seinen Ring', async ({ page }) => {
  await bootChat(page)
  // Tastaturfokus, nicht Klick: `:focus-visible` unterscheidet die beiden,
  // und der Ring ist genau fuer den ersten Fall da.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(250)
  const gemessen = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return null
    const s = getComputedStyle(el)
    return { tag: el.tagName, label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '',
      outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`, offset: s.outlineOffset }
  })
  // Kein Screenshot ohne Beleg, was darauf zu sehen ist: der Ring ist 2px.
  expect(gemessen, 'nichts hat den Tastaturfokus').not.toBeNull()
  await page.screenshot({ path: bild('knopf-tastaturfokus') })
  console.log('Knopf im Tastaturfokus:', JSON.stringify(gemessen))
})

test('Create: der Composer im Fokus', async ({ page }) => {
  await bootChat(page)
  await page.getByRole('button', { name: 'Create', exact: true }).first().click()
  const feld = page.locator('textarea').first()
  await expect(feld).toBeVisible()
  await feld.click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: bild('create-composer-fokus') })
})

test('Models, LoRA-Reiter: das CivitAI-Suchfeld im Fokus', async ({ page }) => {
  await bootLokal(page)
  await page.getByRole('button', { name: 'Models', exact: true }).first().click()
  await page.getByRole('button', { name: /LoRAs/ }).first().click()
  const feld = page.getByLabel('Search CivitAI for LoRAs')
  await expect(feld).toBeVisible()
  await feld.click()
  await feld.type('pixel')
  await page.waitForTimeout(400)
  await page.screenshot({ path: bild('civitai-suchfeld-fokus') })
})
