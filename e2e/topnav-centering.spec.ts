import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * The owner (18.09.2026): "die Reitergruppe [Chat/Create/Compare/Benchmark/
 * Models/Settings] sitzt irgendwie falsch mittig". Sein Massstab: die
 * horizontale Mitte dieser Gruppe soll ueber dem "VS" liegen, das im
 * Compare-Screen zwischen Model A und Model B steht, "das ist genau die
 * Mitte des Programms".
 *
 * Befund vor dem Fix (Header.tsx, grid-cols-[auto_1fr_auto]): die Mitte-
 * Spalte war der REST zwischen zwei ungleich breiten Aussenspalten (links
 * Burger+Logo, rechts vier Werkzeuge), und `justify-center` zentrierte nur
 * INNERHALB dieser Restflaeche. Gemessen am laufenden Fenster stand die
 * Reihe deshalb 59,7px links von der Fenster- und VS-Achse, bei jeder
 * Fensterbreite und in Cloud wie Lokal gleich weit (die Differenz kommt
 * allein aus den Aussenspalten, nicht aus der Fensterbreite oder dem
 * Betriebsmodus). Der Fix (`grid-cols-[1fr_auto_1fr]`) macht die Mitte zu
 * einer eigenen, inhaltsgetriebenen Spalte zwischen zwei GLEICH GROSSEN
 * Restspalten, die automatisch auf der Fenstermitte liegt.
 *
 * Das VS selbst zentriert sich im Inhaltsbereich (ABCompare.tsx,
 * grid-cols-[1fr_auto_1fr]); Compare blendet die Seitenleiste aus
 * (`AppShell.tsx`: `{!isComparing && <Sidebar />}`), und bei symmetrischem
 * `p-2` liegt dieser Inhaltsbereich im Fenster mittig, Fenstermitte und
 * VS-Achse sind hier also dieselbe Achse.
 *
 * Gegenprobe: mit der alten Anordnung (`auto_1fr_auto`) ist die Differenz
 * ~59,7px bei jeder Breite, weit ueber der 1px-Toleranz unten. Siehe
 * bau/topnav.md fuer die Messreihe.
 */

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.locator('nav[aria-label="Main"]')).toBeVisible()
}

async function gotoCompare(page: Page) {
  const wide = page.getByRole('button', { name: 'Compare', exact: true }).first()
  if (await wide.isVisible().catch(() => false)) {
    await wide.click()
    return
  }
  // Below the `lg` breakpoint the six-item bar is collapsed into the kebab
  // menu, same target view, reached through the overflow menu instead.
  await page.getByRole('button', { name: 'Main navigation' }).click()
  await page.getByRole('menuitem', { name: 'Compare', exact: true }).click()
}

const WIDTHS = [1100, 1280, 1440, 1920]

for (const width of WIDTHS) {
  test(`nav group centers on the VS axis at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await boot(page)
    await gotoCompare(page)
    await expect(page.getByText('VS', { exact: true })).toBeVisible()

    const navBox = await page.locator('nav[aria-label="Main"]').boundingBox()
    const vsBox = await page.getByText('VS', { exact: true }).boundingBox()
    expect(navBox, 'nav group bounding box').not.toBeNull()
    expect(vsBox, 'VS bounding box').not.toBeNull()

    const navCenter = navBox!.x + navBox!.width / 2
    const vsCenter = vsBox!.x + vsBox!.width / 2
    expect(Math.abs(navCenter - vsCenter), `nav center ${navCenter} vs VS center ${vsCenter}`).toBeLessThanOrEqual(1)
  })
}

/**
 * Auflage 1 (Runde 2, review-ui-whatsnew-topnav.md Teil B): der urspruenglich
 * gemessene enge Fall war der Compare-Screen, dort ist die rechte Gruppe am
 * kuerzesten (drei ruhige Werkzeuge). Auf dem Chat-View kann rechts
 * zusaetzlich der Stale-Chip (`Header.tsx:479-506`) UND das Update-Badge
 * (`UpdateBadge.tsx`) stehen, und das ist der eigentliche enge Fall.
 *
 * Vorher/nachher (siehe bau/topnav.md, "Runde 2"): bei 1024px lief die rechte
 * Gruppe (natuerliche Breite ~469px) auf ihrem gleich grossen 1fr-Anteil
 * (~281px) links aus sich selbst heraus und ueberlappte die letzten beiden
 * Reiter samt Stale-Chip ("Settings" auf "Refresh", der Chip-Text auf dem
 * Cloud-Schalter). Der Fix nimmt der rechten Spalte `min-w-0`
 * (`Header.tsx`, rechte Gruppe): ihre automatische Mindestbreite ist jetzt ihr
 * eigener Inhalt, sie kann nicht mehr enger werden als das, was darin steht.
 * Die Reitergruppe weicht in diesem seltenen Zusammentreffen von der
 * Fenstermitte ab, das ist die Abwaegung aus der Auflage, keine Verletzung
 * der Zentrierungs-Tests oben, die ohne Stale-Chip und Update-Badge laufen.
 */
async function seedStaleAndUpdate(page: Page, model: string, latestVersion: string) {
  await page.addInitScript(({ model, latestVersion }) => {
    // modelHealthStore ("locally-uncensored-model-health"): marks `model`
    // stale so Header's effect (Header.tsx:154-182) raises the chip without
    // a failed load attempt first.
    window.localStorage.setItem(
      'locally-uncensored-model-health',
      JSON.stringify({
        state: { staleModels: [model], lastScanTime: Date.now(), scanning: false, dismissed: false },
        version: 0,
      }),
    )
    // chat-models ("chat-models"): pins `model` as the active chat model so
    // `isOllamaModel` is true (no `::` prefix = ollama, model-name.ts:29-31).
    window.localStorage.setItem(
      'chat-models',
      JSON.stringify({
        state: { activeModel: model, lastLocalModel: model, lastCloudModel: null, categoryFilter: 'all' },
        version: 0,
      }),
    )
    // updateStore ("lu-update-checker-v2"): `latestVersion` must be newer
    // than the running build or `onRehydrateStorage` (updateStore.ts:569-573)
    // resets it straight back to null.
    window.localStorage.setItem(
      'lu-update-checker-v2',
      JSON.stringify({
        state: {
          lastChecked: Date.now(),
          latestVersion,
          updateAvailable: true,
          releaseNotes: null,
          autoDownload: true,
        },
        version: 0,
      }),
    )
    // lu-providers: Ollama is `enabled: false` by default (providerStore.ts),
    // so `chat-models`' persisted pick above would fail `useModels.ts`'
    // "stillValid" check on the very first fetch (the model never shows up in
    // any enabled provider's list) and get swapped for the built-in engine's
    // own model, which is also named `model` (tauri-mock reports it as loaded
    // regardless of provider). Same fixture shape as
    // anbieter-test-sagt-was-er-geprueft-hat.spec.ts.
    window.localStorage.setItem(
      'lu-providers',
      JSON.stringify({
        state: {
          hideBackendSelector: true,
          providers: {
            ollama: { id: 'ollama', name: 'Ollama', enabled: true, baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true },
            openai: { id: 'openai', name: 'LU Engine', enabled: false, baseUrl: 'http://localhost:8127/v1', apiKey: '', isLocal: true },
            anthropic: { id: 'anthropic', name: 'Anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKey: '', isLocal: false },
            'lu-cloud': { id: 'lu-cloud', name: 'LU Cloud', enabled: false, baseUrl: 'https://lu-labs.ai/api/inference/v1', apiKey: '', isLocal: false },
          },
        },
        version: 1,
      }),
    )
  }, { model, latestVersion })
}

const COLLISION_WIDTHS = [1024, 1100, 1280]

for (const width of COLLISION_WIDTHS) {
  test(`chat view with stale chip and update badge does not overlap or clip at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.addInitScript(tauriMockInit, {
      assistantReply: DEFAULT_ASSISTANT_REPLY,
      modelName: DEFAULT_MODEL_NAME,
      ollamaModels: [DEFAULT_MODEL_NAME],
    })
    await seedOnboardingDone(page)
    await seedStaleAndUpdate(page, DEFAULT_MODEL_NAME, '99.0.0')
    await page.goto('/')
    await expect(page.locator('nav[aria-label="Main"]')).toBeVisible()

    const staleChip = page.getByText('stale', { exact: true })
    const updateBadge = page.getByTitle(/Update available/i)
    await expect(staleChip).toBeVisible()
    await expect(updateBadge).toBeVisible()
    // The full label is not collapsed to the bare icon at this width (that
    // only happens below `md`, UpdateBadge.tsx:104): a real check that the
    // text is not clipped away, not just that SOME node with this title exists.
    await expect(page.getByText(/^Update to v99\.0\.0$/)).toBeVisible()

    const navBox = await page.locator('nav[aria-label="Main"]').boundingBox()
    const rightGroup = page.locator('header > div.flex.items-center.justify-end')
    const rightBox = await rightGroup.boundingBox()
    // The rendered content of the right group, independent of the box the
    // grid track assigned it: this is what actually painted overlap onto the
    // nav before the fix, even though the two DIV boxes themselves never
    // touched (Runde-2-Befund, see bau/topnav.md).
    const rightContent = await rightGroup.evaluate((el) => {
      const rects = Array.from(el.children).map((k) => (k as HTMLElement).getBoundingClientRect())
      return { left: Math.min(...rects.map((r) => r.left)) }
    })
    expect(navBox, 'nav group bounding box').not.toBeNull()
    expect(rightBox, 'right group bounding box').not.toBeNull()

    expect(rightContent.left, `right content starts at ${rightContent.left}, nav ends at ${navBox!.x + navBox!.width}`)
      .toBeGreaterThanOrEqual(navBox!.x + navBox!.width)
    // The box itself and its painted content agree, nothing spills out of
    // its own column either.
    expect(rightContent.left).toBeCloseTo(rightBox!.x, 0)
  })
}

test('at the lg breakpoint the centered bar does not overlap the side groups', async ({ page }) => {
  // 1024px is the `lg` breakpoint (`hidden lg:flex` in Header.tsx) where the
  // full six-item bar first appears: the tightest realistic squeeze between
  // the centered group and the fixed-width side groups.
  await page.setViewportSize({ width: 1024, height: 800 })
  await boot(page)
  await gotoCompare(page)
  await expect(page.getByText('VS', { exact: true })).toBeVisible()

  const bar = page.locator('nav[aria-label="Main"] > div.hidden.lg\\:flex')
  const barBox = await bar.boundingBox()
  const logo = await page.getByRole('button', { name: 'LU' }).boundingBox()
  const cloudSwitch = await page.getByRole('switch', { name: /^Cloud$/i }).boundingBox()
  expect(barBox && logo && cloudSwitch, 'bar, logo and cloud switch all present').toBeTruthy()

  const barLeft = barBox!.x
  const barRight = barBox!.x + barBox!.width
  const leftGroupEnd = logo!.x + logo!.width
  const rightGroupStart = cloudSwitch!.x

  expect(barLeft, 'bar does not reach into the left group').toBeGreaterThan(leftGroupEnd)
  expect(barRight, 'bar does not reach into the right group').toBeLessThan(rightGroupStart)
})

test('left and right header groups keep their pixel position across views', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
  const toggleBefore = await page.getByRole('button', { name: /Toggle sidebar/i }).boundingBox()
  const themeBefore = await page.getByRole('button', { name: /Light Mode|Dark Mode/i }).boundingBox()

  await gotoCompare(page)
  await expect(page.getByText('VS', { exact: true })).toBeVisible()

  const toggleAfter = await page.getByRole('button', { name: /Toggle sidebar/i }).boundingBox()
  const themeAfter = await page.getByRole('button', { name: /Light Mode|Dark Mode/i }).boundingBox()

  expect(toggleAfter!.x).toBeCloseTo(toggleBefore!.x, 3)
  expect(themeAfter!.x).toBeCloseTo(themeBefore!.x, 3)
})
