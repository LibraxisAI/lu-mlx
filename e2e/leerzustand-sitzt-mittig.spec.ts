import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, oeffneSeitenleiste } from './support/ui'

/**
 * 19.09.2026: "Ask LU anything" (der Leerzustand vor der ersten
 * Nachricht) sass zu tief statt mittig, und dieselbe Ursache traf zwei
 * weitere Leerzustaende in derselben Datei: den "New Chat"-Bildschirm mit
 * der Liste der letzten Chats (2026-09-02) und den Code-Reiter vor
 * einer offenen Unterhaltung.
 *
 * Ursache (ChatView.tsx, gefunden per git blame): der Block, der `chat-
 * landing` traegt, ist `flex-1` in einer Spalte, deren einziger anderer
 * Bewohner der Composer ist (`<ChatInput>`, direkt danach, ausserhalb der
 * AnimatePresence). Der Block selbst ist also GENAU die sichtbare Flaeche
 * zwischen der Kopfleiste (ausserhalb dieser Datei) und der Composer-
 * Oberkante, `justify-center` auf ihm zentriert den Inhalt also in exakt
 * dieser Flaeche, keine externe Referenz noetig. Bis zum 05.09.2026
 * (`b1ccb3a5c`) stand hier fuer den Chat-Zweig `justify-end`: der Block
 * sollte "wie ein Element mit dem Composer lesen". Gemessen (Playwright,
 * headless Chromium, `LU_DEV_PORT`, 19.09.2026):
 *
 *   Lage                          1100x700   1100x1080   1440x1080
 *   Chat, lokal, Leiste zu          +26,0 %     +36,4 %     +36,4 %
 *   Chat, Cloud, Leiste zu          +25,9 %     +36,4 %     +36,4 %
 *   New-Chat-Recents, Leiste zu     +34,7 %     +41,6 %     +41,6 %
 *   Code-Reiter (schon justify-center)  -1,5 %   -0,9 %      -0,9 %
 *
 * (+ = Blockmitte tiefer als Flaechenmitte, in Prozent der Flaechenhoehe.)
 * Der Code-Reiter war damit schon richtig; Chat und die Recents-Liste
 * lagen 26 bis 42 Prozent zu tief, und die Abweichung wuchs mit der
 * Fensterhoehe, weil `justify-end` den Block an den Composer nagelt statt
 * an die Mitte. Fix: dieselbe Regel (`justify-center`, ohne Bedingung) in
 * beiden betroffenen Stellen von ChatView.tsx.
 *
 * Die Gegenprobe unten haelt den alten Fehler als Zahl fest (Kommentar,
 * nicht Code-Revert: ein zweiter Server-Start mit dem alten Stand waere ein
 * zweites Playwright-Projekt fuer eine einzige Zahl) und prueft LIVE, dass
 * die heutige Blockmitte innerhalb von 4 Prozent der Flaechenmitte liegt
 * und nie DARUNTER, genau die Regel aus dem Auftrag. Wird `justify-end`
 * (oder ein Aequivalent) wieder eingefuehrt, faellt dieser Test, weil die
 * Live-Messung wieder ueber 25 Prozent liegt.
 */

interface Measurement {
  blockCenterY: number
  areaCenterY: number
  areaHeight: number
  deviationPct: number
}

/** `[data-testid="chat-landing"]`'s own parent IS the visible area: it is
 *  the `flex-1` container between (nothing, in the landing state) and the
 *  composer, which follows immediately as the next flex sibling. */
async function measureLanding(page: Page): Promise<Measurement> {
  const result = await page.evaluate(() => {
    const block = document.querySelector('[data-testid="chat-landing"]') as HTMLElement | null
    if (!block) return null
    const area = block.parentElement as HTMLElement
    const bRect = block.getBoundingClientRect()
    const aRect = area.getBoundingClientRect()
    const blockCenterY = (bRect.top + bRect.bottom) / 2
    const areaCenterY = (aRect.top + aRect.bottom) / 2
    const areaHeight = aRect.height
    const deviationPct = ((blockCenterY - areaCenterY) / areaHeight) * 100
    return { blockCenterY, areaCenterY, areaHeight, deviationPct }
  })
  expect(result, '[data-testid="chat-landing"] not found').not.toBeNull()
  return result as Measurement
}

/** Ein Nutzer nimmt "mittig" so wahr: der Block darf minimal ueber der
 *  rechnerischen Mitte sitzen (bis zu 4 % der Flaechenhoehe), aber nie
 *  darunter (Auftrag 19.09.2026). */
function expectMittig(m: Measurement) {
  expect(m.deviationPct).toBeLessThanOrEqual(4)
  expect(m.deviationPct).toBeGreaterThanOrEqual(-4)
}

const sizes: Array<{ label: string; width: number; height: number }> = [
  { label: '1100x700', width: 1100, height: 700 },
  { label: '1440x1080', width: 1440, height: 1080 },
]

for (const { label, width, height } of sizes) {
  test(`Chat-Leerzustand sitzt mittig bei ${label}`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
    await seedOnboardingDone(page)
    await page.setViewportSize({ width, height })
    await page.goto('/')
    await expect(page.getByTestId('chat-landing')).toBeVisible()
    const m = await measureLanding(page)
    expectMittig(m)
  })

  // 3.0.4 Gegenprobe (02.10.2026): ohne Unterhaltung zeigte der Code-Bereich
  // die Chat-Eingangsseite ohne Eingabefeld. Jetzt steht dort die Code-Ansicht
  // mit ihrem Composer; ihr Leerblock muss genauso mittig sitzen.
  test(`Code-Leerzustand sitzt mittig bei ${label} und hat ein Eingabefeld`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
    await seedOnboardingDone(page)
    await page.setViewportSize({ width, height })
    await page.goto('/')
    await expect(page.getByTestId('chat-landing')).toBeVisible()
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await expect(page.getByTestId('codex-landing')).toBeVisible()
    await expect(page.getByRole('main').locator('textarea')).toBeVisible()
    const m = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="codex-landing"]') as HTMLElement
      const kids = Array.from(box.children) as HTMLElement[]
      const top = Math.min(...kids.map((k) => k.getBoundingClientRect().top))
      const bottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom))
      const a = box.getBoundingClientRect()
      return { blockCenterY: (top + bottom) / 2, areaCenterY: (a.top + a.bottom) / 2, areaHeight: a.height, deviationPct: (((top + bottom) / 2 - (a.top + a.bottom) / 2) / a.height) * 100 }
    })
    expectMittig(m)
  })
}

test('New-Chat-Recents-Leerzustand sitzt mittig (Seitenleiste zu)', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto('/')
  await openNewChat(page)
  // Past the AnimatePresence exit/enter transition, sonst liest man noch den
  // alten "home"-Baum.
  await expect(page.getByTestId('chat-session-strip')).toBeVisible()
  // F1-Fix (19.09.2026, box-gruen/n2/BERICHT.md): der Block fuer eine
  // aktive, leere Unterhaltung ist jetzt derselbe `chat-landing`-Block wie
  // die Eingangsseite (Zeichen, "Ask LU anything", Modellname), nur MIT der
  // Recents-Liste darunter statt ohne sie. Dieselbe `measureLanding`-Funktion
  // wie fuer die anderen Faelle greift deshalb unveraendert.
  await expect(page.getByTestId('home-recent-chats')).toBeVisible()
  const m = await measureLanding(page)
  expectMittig(m)
})

/**
 * F2 (19.09.2026, box-gruen/n2/BERICHT.md Teil A): der Remote-Reiter
 * (Dispatch-Ansicht, noch keine dispatchte Unterhaltung) lief in der
 * Windows-Feldsitzung 8,7 % von der Flaechenmitte weg statt der im
 * Code-Reiter gemessenen 1,3 %. Quelltextlich ist es DERSELBE `!activeConversationId`-
 * Zweig wie im Chat-Reiter (Sidebar.tsx setzt beim Klick auf "Remote"
 * `setActiveConversation(dispatchedConversationId)`, und ohne vorherigen
 * Dispatch ist das `undefined`/`null`), kein eigener Leerzustand-Code. Die
 * Feldmessung stammt vermutlich von einem Bau vor dem `justify-center`-Fix
 * dieser Datei. Live gemessen haelt dieser Test die Behauptung "denselben
 * Codepfad, dieselbe Mitte" nach.
 */
for (const { label, width, height } of sizes) {
  test(`Remote-Leerzustand (Dispatch) sitzt mittig bei ${label}`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
    await seedOnboardingDone(page)
    await page.setViewportSize({ width, height })
    await page.goto('/')
    await expect(page.getByTestId('chat-landing')).toBeVisible()
    await page.getByRole('button', { name: 'Remote', exact: true }).first().click()
    await expect(page.getByTestId('chat-landing')).toBeVisible()
    const m = await measureLanding(page)
    expectMittig(m)
  })
}

/**
 * F1 (19.09.2026, box-gruen/n2/BERICHT.md Teil A, schwerer Nebenfund):
 * "+ New Chat" legt sofort eine aktive, aber leere Unterhaltung an
 * (`createConversation` setzt `activeConversationId` synchron, chatStore.ts).
 * Die alte Bedingung fuer den Leerzustand-Block war `!activeConversationId`
 * (traf auf diese Lage nie zu), plus ein zweiter Block NUR bei
 * zugeklappter Seitenleiste. Bei AUFGEKLAPPTER Seitenleiste (die Windows-
 * Feldsitzung stand so, siehe n2/shots/n9r-chat-blank1.png) rendert deshalb
 * NICHTS: kein Leerzustand, kein Verlauf, auch nicht nach vollem
 * `page.reload()`. Dieser Test stellt genau das nach und ist die Beweiskette
 * fuer den Fix: der Block muss sofort da sein UND nach einem Neuladen
 * WIEDER da sein, ohne einen Reiterwechsel als Umweg zu brauchen.
 */
test('F1: eine neue leere Unterhaltung bleibt sichtbar, auch aufgeklappt und nach Neuladen', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto('/')
  // Erst auf die hydrierte Oberflaeche warten, sonst sieht `oeffneSeitenleiste`
  // den "Expand sidebar"-Knopf noch nicht und tut nichts (dieselbe Rennlage,
  // die openNewChat's Kommentar oben fuer den New-Chat-Knopf beschreibt).
  await expect(page.getByRole('button', { name: 'New Chat' }).first()).toBeVisible()
  await oeffneSeitenleiste(page)
  await openNewChat(page)
  // Erst abwarten, dass wirklich eine AKTIVE Unterhaltung steht (die
  // Sitzungsleiste rendert nur dann), sonst faengt die naechste Zeile den
  // kurzen Zwischenzustand VOR dem Store-Update ab, in dem die alte,
  // unbetroffene "keine Unterhaltung"-Landing noch im DOM haengt, und
  // beweist gar nichts. Das war die Falle, die diesen Test beim ersten
  // Versuch auch gegen den alten, kaputten Stand gruen liess.
  await expect(page.getByTestId('chat-session-strip')).toBeVisible()
  // Sofort da, nicht erst nach einem Reiterwechsel.
  await expect(page.getByTestId('chat-landing')).toBeVisible()
  await expect(page.getByText('Ask LU anything')).toBeVisible()
  // Bei aufgeklappter Seitenleiste keine zweite Chat-Liste im Hauptbereich
  // (die Liste lebt schon in der Seitenleiste, D-S06).
  await expect(page.getByTestId('home-recent-chats')).toHaveCount(0)

  // Der eigentliche Fund: volles Neuladen derselben, weiterhin leeren
  // Unterhaltung durfte den Block vorher zum Verschwinden bringen.
  await page.reload()
  await expect(page.getByTestId('chat-landing')).toBeVisible()
  await expect(page.getByText('Ask LU anything')).toBeVisible()

  // NEGATIVKONTROLLE: sobald die erste Nachricht da ist, weicht der Block
  // dem echten Transkript (kein doppelter Leerzustand ueber einer Antwort).
  const composer = page.locator('textarea').first()
  await composer.fill('Hallo')
  await composer.press('Enter')
  await expect(page.getByText('Hallo', { exact: false }).first()).toBeVisible()
  await expect(page.getByTestId('chat-landing')).toHaveCount(0)
})

test('kein Layoutsprung: der Composer bewegt sich nicht, wenn die erste Nachricht ankommt', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto('/')
  await expect(page.getByTestId('chat-landing')).toBeVisible()
  const composer = page.locator('textarea').first()
  const before = await composer.boundingBox()
  await composer.fill('Hallo')
  await composer.press('Enter')
  await expect(page.getByText('Hallo', { exact: false }).first()).toBeVisible()
  const after = await composer.boundingBox()
  expect(before).not.toBeNull()
  expect(after).not.toBeNull()
  // Die Box darf durch neuen Inhalt (Modellmarken, Notiz) leicht wachsen,
  // ihre OBERKANTE darf sich aber nicht mehr als ein paar Pixel verschieben:
  // das Eingabefeld haengt am Fensterrand, nicht am Transkript.
  expect(Math.abs((after as { y: number }).y - (before as { y: number }).y)).toBeLessThanOrEqual(4)
})
