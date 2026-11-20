import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { openNewChat, appModules, type AppWindow } from './support/ui'

/**
 * Issue 138 (Windows 10, nach dem Sprung 3.0.0 auf 3.0.1): der
 * Code-Reiter zeigt bei einer langen Unterhaltung nur den Anfang des
 * Verlaufs. Keine Bildlaufleiste, das Mausrad bewirkt nichts, und das
 * Eingabefeld samt Werkzeugzeile ist gar nicht mehr zu sehen, weil es unter
 * den unteren Fensterrand geschoben wurde.
 *
 * Wurzel: `3d826a26` stellte den Aussenrahmen in `CodexView.tsx` von
 * `overflow-hidden` auf `overflow-clip` um, ohne `min-h-0` nachzuziehen.
 * `overflow: hidden` macht ein Element zum Bildlaufbehaelter, und fuer einen
 * Bildlaufbehaelter ist die automatische Mindesthoehe eines Flex-Kindes 0.
 * `overflow: clip` ist KEIN Bildlaufbehaelter (CSS Overflow Module Level 3),
 * damit faellt `min-height: auto` auf die Inhaltshoehe zurueck: der Rahmen
 * waechst mit dem Verlauf ueber das Fenster hinaus, der Verlauf selbst
 * (`flex-1 min-h-[10rem] overflow-y-auto`) bekommt nie mehr Ueberlauf und
 * also nie eine Bildlaufleiste, und der Composer darunter rutscht aus dem
 * Fenster. `ChatView.tsx` bekam im selben Umbau `min-h-0` und ist deshalb
 * heil geblieben, der Code-Reiter nicht.
 *
 * Diese Spec misst genau diese vier Dinge am laufenden Baum, an einem
 * Verlauf, der hoeher als das Fenster ist.
 */

const FENSTER = { width: 1280, height: 800 }

/** So viele Nachrichten, dass der Verlauf das Fenster sicher ueberfuellt. */
const NACHRICHTEN = 60

async function bootCode(page: Page): Promise<void> {
  await page.setViewportSize(FENSTER)
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.goto('/')
  // Modus zuerst, dann der Chat: der Moduswechsel raeumt die aktive
  // Unterhaltung weg (so dokumentiert in `coding-agent.spec.ts`).
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await openNewChat(page)
}

/**
 * Den Verlauf fuellen, ohne den Agenten laufen zu lassen: nur Eingabestand
 * wird gesetzt, gerendert wird alles von der Produktionskomponente. Dasselbe
 * Muster wie in `memory-hook-sources.spec.ts`, das den Chat-Store ebenso
 * direkt aus dem laufenden Modul zieht.
 */
async function langenVerlaufSetzen(page: Page, anzahl: number): Promise<void> {
  await appModules(page, ['/src/stores/chatStore.ts'])
  await page.evaluate((n) => {
    const chat = (window as unknown as AppWindow).__APP__['/src/stores/chatStore.ts'] as typeof import('../src/stores/chatStore')
    const aktiv = chat.useChatStore.getState().activeConversationId
    if (!aktiv) throw new Error('Keine aktive Code-Unterhaltung')
    for (let i = 0; i < n; i++) {
      chat.useChatStore.getState().addMessage(aktiv, {
        id: `i138-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Zeile ${i + 1} eines langen Code-Verlaufs, lang genug fuer eine eigene Zeile im Verlauf.`,
        timestamp: Date.now() + i,
      })
    }
  }, anzahl)
}

test('Code-Reiter: ein Verlauf hoeher als das Fenster scrollt und laesst den Composer im Bild', async ({ page }) => {
  await bootCode(page)
  await langenVerlaufSetzen(page, NACHRICHTEN)

  const verlauf = page.getByTestId('codex-transcript')
  await expect(verlauf).toBeVisible()
  // Auf den gewachsenen Verlauf warten, nicht auf eine Frist.
  await expect(verlauf.getByText(`Zeile ${NACHRICHTEN} eines langen Code-Verlaufs`, { exact: false })).toBeAttached()

  const mass = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="codex-transcript"]') as HTMLElement
    // Der Aussenrahmen aus `CodexView.tsx`: der naechste Vorfahr des Verlaufs,
    // der clippt. `overflow: clip` und `overflow: hidden` haben im CSS Overflow
    // Module Level 3 verschiedene Rechenwerte, beide werden geprueft, sonst
    // faende die Suche den naechsten `overflow-hidden`-Vorfahren weiter oben.
    let rahmen: HTMLElement | null = el.parentElement
    while (rahmen) {
      const cs = getComputedStyle(rahmen)
      if (['hidden', 'clip'].includes(cs.overflowX) || ['hidden', 'clip'].includes(cs.overflowY)) break
      rahmen = rahmen.parentElement
    }
    const r = el.getBoundingClientRect()
    const rr = rahmen?.getBoundingClientRect()
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      verlaufUnten: r.bottom,
      rahmenHoehe: rr ? rr.height : null,
      seitenHoehe: document.documentElement.scrollHeight,
      fensterHoehe: window.innerHeight,
    }
  })

  // 1. Der Verlauf hat echten Ueberlauf, also eine Bildlaufleiste und ein
  //    wirksames Mausrad. Vor dem Fix wuchs er einfach mit dem Inhalt mit.
  expect(mass.scrollHeight, 'der Verlauf muss ueberlaufen (Bildlaufleiste)').toBeGreaterThan(mass.clientHeight)

  // 2. Und er ist kleiner als das Fenster, sonst ist "Ueberlauf" nur eine
  //    Folge eines Rahmens, der selbst schon aus dem Fenster ragt.
  expect(mass.clientHeight, 'der Verlauf bleibt niedriger als das Fenster').toBeLessThan(mass.fensterHoehe)

  // 3. Der Aussenrahmen und die Seite bleiben im Fenster, nichts wird nach
  //    unten hinausgeschoben.
  expect(mass.rahmenHoehe, 'der Aussenrahmen muss messbar sein').not.toBeNull()
  if (mass.rahmenHoehe !== null) {
    expect(mass.rahmenHoehe, 'der Aussenrahmen bleibt im Fenster').toBeLessThanOrEqual(mass.fensterHoehe + 1)
  }
  expect(mass.seitenHoehe, 'die Seite selbst waechst nicht ueber das Fenster').toBeLessThanOrEqual(mass.fensterHoehe + 1)

  // 4. Der Composer liegt vollstaendig im sichtbaren Bereich. Das ist der
  //    Befund des Melders: das Eingabefeld war schlicht weg.
  const composer = page.locator('textarea').first()
  await expect(composer).toBeVisible()
  const kasten = await composer.boundingBox()
  expect(kasten, 'der Composer muss ein messbares Rechteck haben').not.toBeNull()
  if (kasten) {
    expect(kasten.y, 'oberer Rand des Composers im Fenster').toBeGreaterThanOrEqual(0)
    expect(kasten.height, 'eine echte Hoehe, nicht auf 0 geclippt').toBeGreaterThan(10)
    expect(kasten.y + kasten.height, 'unterer Rand des Composers im Fenster').toBeLessThanOrEqual(FENSTER.height + 1)
  }
  // Der Verlauf endet oberhalb des Composers, ueberdeckt ihn also nicht.
  expect(mass.verlaufUnten, 'der Verlauf endet im Fenster').toBeLessThanOrEqual(mass.fensterHoehe + 1)
})
