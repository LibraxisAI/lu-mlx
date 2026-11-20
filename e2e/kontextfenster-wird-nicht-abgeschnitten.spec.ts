import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { openNewChat } from './support/ui'

/**
 * Am 07.09.2026: das Kontextfenster im Chat ist abgeschnitten, "wenn man
 * den Context neu ausfuellen moechte".
 *
 * Nachgemessen bei 1280x800, vor der Reparatur: die Liste stand von y=686 bis
 * y=874. Das Fenster endet bei 800, der `<main>`-Kasten mit `overflow-hidden`
 * (die abgerundete Pane) schon bei 790,8. Sichtbar waren 105 von 188 px, die
 * halbe Auswahl fehlte, und `32K` und der Hinweis darunter waren gar nicht zu
 * erreichen.
 *
 * Die Ursache war eine Annahme, keine Klasse: das Menue ging fest nach unten
 * auf (`top-full`), und sein Ausloeser ist mit dem 2.6.8-Umbau der
 * Eingabezeile von oberhalb des Verlaufs an den unteren Rand gewandert, direkt
 * ueber den Composer. Darunter sind rund 100 px Platz.
 *
 * Gemessen wird hier gegen die Flaeche, die WIRKLICH abschneidet, und nicht
 * gegen das Fenster: die beiden liegen 9 px auseinander, und wer gegen das
 * Fenster prueft, laesst genau diese 9 px durchgehen.
 */

async function completeBuiltinOnboarding(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await page.goto('/')

  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()
  await expect(page.getByRole('button', { name: /Continue/i })).toBeVisible()
  await page.getByRole('button', { name: /Continue/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible()
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('heading', { name: /Pick a starter model/i })).toBeVisible()
  await page.getByRole('button', { name: /Qwen 2\.5 7B/i }).click()
  await page.getByRole('button', { name: /Install \d+ model/i }).click()
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Skip for now/i }).click()
  await expect(page.getByRole('button', { name: /Get Started/i })).toBeVisible()
  await page.getByRole('button', { name: /Get Started/i }).click()
}

/** Liste, Fensterhoehe und die Kanten der abschneidenden Flaeche. */
async function messen(page: Page) {
  const auto = page.getByRole('button', { name: /^Auto/ })
  await expect(auto).toBeVisible()
  return auto.locator('xpath=..').evaluate((el) => {
    let oben = 0
    let unten = window.innerHeight
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        const b = p.getBoundingClientRect()
        oben = b.top
        unten = b.bottom
        break
      }
    }
    const r = el.getBoundingClientRect()
    return {
      top: r.top,
      bottom: r.bottom,
      hoehe: r.height,
      sichtbar: el.clientHeight,
      inhalt: el.scrollHeight,
      grenzeOben: oben,
      grenzeUnten: unten,
    }
  })
}

test('die Kontextliste bleibt ganz in der Flaeche, die sie abschneiden koennte', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await completeBuiltinOnboarding(page)
  await openNewChat(page)

  const trigger = page.getByRole('button', { name: 'Context window' })
  await expect(trigger).toHaveCount(1)
  await trigger.click()

  const m = await messen(page)
  // Die eigentliche Zusage, in beide Richtungen.
  expect(m.bottom, `die Liste ragt ${Math.round(m.bottom - m.grenzeUnten)} px unter die abschneidende Kante`)
    .toBeLessThanOrEqual(m.grenzeUnten)
  expect(m.top, `die Liste ragt ${Math.round(m.grenzeOben - m.top)} px ueber die abschneidende Kante`)
    .toBeGreaterThanOrEqual(m.grenzeOben)

  // Und sie ist nicht dadurch "ganz drin", dass sie ihren Inhalt weggekuerzt
  // hat: in diesem Fenster ist Platz genug, also steht sie vollstaendig da,
  // von der obersten Auswahl bis zur letzten Zeile. Ohne diese beiden Faelle
  // waere ein Menue gruen, das die Kante haelt und trotzdem an der Auswahl
  // vorbeigeht.
  // Seit dem 11.09.2026 heisst die oberste Zeile "32K · max": die Decke
  // fuehrt die Liste sichtbar an.
  await expect(page.getByRole('button', { name: /^32K( · max)?$/ })).toBeInViewport({ ratio: 1 })
  await expect(page.getByText('Reloads the model on change.')).toBeInViewport({ ratio: 1 })
})

test('im flachen Fenster scrollt sie, statt aus der Flaeche zu laufen', async ({ page }) => {
  // Die Gegenprobe zum Kippen: hier reicht WEDER oben noch unten. Ohne die
  // Hoehendeckelung waere das Menue wieder abgeschnitten, und mit einer
  // Mindesthoehe waere es das auch: der erste Anlauf hatte 96 px als
  // Untergrenze und stand damit hier 6 px im Geschnittenen.
  await page.setViewportSize({ width: 1280, height: 300 })
  await completeBuiltinOnboarding(page)
  await openNewChat(page)

  const trigger = page.getByRole('button', { name: 'Context window' })
  await trigger.click()

  const m = await messen(page)
  expect(m.bottom).toBeLessThanOrEqual(m.grenzeUnten)
  expect(m.top).toBeGreaterThanOrEqual(m.grenzeOben)
  // Gedeckelt, also gescrollt, und nicht ueber die Kante gewachsen.
  expect(m.inhalt, 'die Liste haette hier scrollen muessen').toBeGreaterThan(m.sichtbar)
})

/**
 * GitHub #149, 03.10.2026: seit dem Befund in Create gehen alle Aufklappmenues
 * ueber dieselbe Platzlogik (`usePopoverPlatz`). Hier die beiden, die neben der
 * Kontextliste in der Eingabezeile sitzen, im 400 px hohen Fenster eines
 * Tiling-Fenstermanagers: beide bleiben ganz in der Flaeche, die sie
 * abschneiden koennte, und was nicht passt, scrollt.
 */
async function inSeinerFlaeche(page: Page, testId: string) {
  const el = page.getByTestId(testId)
  await expect(el).toBeVisible()
  // Erst messen, wenn die Einblendung steht: sie skaliert und verschiebt.
  await expect.poll(() => el.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  return el.evaluate((e) => {
    let oben = 0
    let unten = window.innerHeight
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        const b = p.getBoundingClientRect()
        oben = Math.max(oben, b.top)
        unten = Math.min(unten, b.bottom)
      }
    }
    const r = e.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, oben, unten, breite: window.innerWidth }
  })
}

test('Modellauswahl und Sampling-Popup bleiben im 400 px hohen Fenster in ihrer Flaeche', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await completeBuiltinOnboarding(page)
  await openNewChat(page)
  await page.setViewportSize({ width: 1280, height: 400 })

  await page.getByRole('button', { name: 'Select chat model' }).click()
  const menue = await inSeinerFlaeche(page, 'model-picker-menu')
  expect(menue.top, 'die Modellauswahl ragt oben hinaus').toBeGreaterThanOrEqual(menue.oben)
  expect(menue.bottom, 'die Modellauswahl ragt unten hinaus').toBeLessThanOrEqual(menue.unten)
  expect(menue.left).toBeGreaterThanOrEqual(0)
  expect(menue.right).toBeLessThanOrEqual(menue.breite)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('model-picker-menu')).toHaveCount(0)

  await page.getByTestId('sampling-trigger').click()
  const popup = await inSeinerFlaeche(page, 'sampling-panel')
  expect(popup.top, 'das Sampling-Popup ragt oben hinaus').toBeGreaterThanOrEqual(popup.oben)
  expect(popup.bottom, 'das Sampling-Popup ragt unten hinaus').toBeLessThanOrEqual(popup.unten)
  // Hausregel: ein Popup mit X, und Escape schliesst es auch.
  await expect(page.getByTestId('sampling-close')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sampling-panel')).toHaveCount(0)
})
