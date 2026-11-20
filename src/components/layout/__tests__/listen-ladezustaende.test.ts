/**
 * Die vier Listen-Ladezustände — Audit Welle 3, Punkt 1.
 *
 * WAS SICH HIER PRUEFEN LAESST und was nicht, ausdruecklich:
 *
 *   prüfbar   · dass an allen vier Stellen ein Skelett steht statt eines
 *               Satzes (oder statt nichts),
 *             · dass die Skelette die Klassen der echten Liste TRAGEN —
 *               das ist der Kern der Sache, denn ein Skelett mit anderer
 *               Geometrie erzeugt genau den Sprung, den es verhindern soll,
 *             · dass sie aria-mässig als Ladezustand angesagt werden,
 *             · dass ihre Bewegung `animate-pulse` ist und damit unter
 *               „Bewegung reduzieren" die vorhandene Ausnahme erbt,
 *             · dass der Modellwähler waehrend des Ladens nicht mehr
 *               „No models available" behaupten KANN.
 *
 *   nur im Fenster · ob das Skelett tatsaechlich so hoch ist wie die Liste,
 *               die kommt (das entscheidet der Layout-Algorithmus, nicht der
 *               Quelltext), ob die Zeilenzahl gut gewaehlt ist, und ob der
 *               Puls in der Sidebar-Kachel nicht als Fehler gelesen wird.
 *               Dafuer gibt es in diesem Repo keinen Render-Harness
 *               (`environment: 'node'`), und Screenshots kann dieser Test
 *               nicht machen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

/**
 * Quelltext ohne Kommentare. Ohne das prueft dieser Test seine eigenen
 * Begruendungen: die Kommentare an den vier Stellen ZITIEREN den Satz, der
 * dort stand („Loading models...", „No models available"), und ein Test, der
 * „ist das weg" fragt, faende das Zitat. Dasselbe Vorgehen wie in
 * streaming-does-not-repaint-the-app.test.ts.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SKELETONS = codeOnly(read('components', 'layout', 'ViewSkeletons.tsx'))
const DISCOVER = codeOnly(read('components', 'models', 'DiscoverModels.tsx'))
// Die CivitAI-Karte ist seit dem LoRA-Reiter eine eigene Komponente: dieselbe
// Karte wird zweimal benutzt (Checkpoints hier, LoRAs unter Models > LoRAs),
// und ihr Ladezustand ist deshalb auch nur noch einmal da.
const CIVITAI = codeOnly(read('components', 'models', 'CivitaiSearchPanel.tsx'))
const SELECTOR = codeOnly(read('components', 'models', 'ModelSelector.tsx'))
const CLOUD_PICKER = codeOnly(read('components', 'models', 'CloudModelPicker.tsx'))
const SETTINGS = codeOnly(read('components', 'settings', 'SettingsPage.tsx'))
const CSS = read('index.css')

/** Der Rumpf einer Skelett-Komponente, bis zur naechsten Funktion der Datei. */
function skeleton(name: string): string {
  const at = SKELETONS.search(new RegExp(`(?:^|\\n)(?:export )?function ${name}\\(\\)`))
  expect(at, `${name} fehlt in ViewSkeletons.tsx`).toBeGreaterThanOrEqual(0)
  const rest = SKELETONS.slice(at + 1)
  const next = rest.search(/\n(?:export )?function /)
  return next < 0 ? rest : rest.slice(0, next)
}

/**
 * Das Modell-Raster gibt es seit dem 08.10.2026 in zwei Fassungen: die
 * klassische auf Windows und Linux, die neue auf dem Mac. Jede hat ihre
 * Kachel und damit ihr Skelett, und `ModelGridSkeleton` waehlt zwischen den
 * beiden an derselben Stelle wie die Kachel (models/skin/which.ts).
 */
const RASTER_SKELETTE = ['ModelGridSkeletonClassic', 'ModelGridSkeletonMac'] as const

describe('an allen vier Stellen steht ein Skelett', () => {
  it('1/4 — das Modell-Raster in Discover', () => {
    expect(DISCOVER).toMatch(/\{loading \? \(\s*<ModelGridSkeleton \/>/)
    expect(DISCOVER).not.toContain('Loading models...')
  })

  it('2/4 — die CivitAI-Trefferliste', () => {
    expect(CIVITAI).toContain('{searching && <CivitaiResultsSkeleton />}')
    expect(CIVITAI).not.toContain('Searching CivitAI...')
  })

  it('3/4 — die Liste im Modellwaehler', () => {
    expect(SELECTOR).toContain('{!inventoryLoaded && textModels.length === 0 && <ModelPickerSkeleton />}')
  })

  it('4/4 — die Import-Kandidaten in den Einstellungen', () => {
    expect(SETTINGS).toContain('{scanning && <ImportScanSkeleton />}')
    // Und die echte Liste erscheint erst NACH dem Scan, sonst stuenden
    // Skelett und Restliste des letzten Scans gleichzeitig da.
    expect(SETTINGS).toContain('{candidates !== null && !errors.scan && !scanning && (')
  })
})

describe('der Modellwaehler kann waehrend des Ladens nichts mehr behaupten', () => {
  it('„No models available" haengt an inventoryLoaded, nicht nur an der Laenge', () => {
    // Das ist der eigentliche Befund an dieser Stelle: der Zustand fehlte
    // nicht nur, er war durch eine FALSCHE Aussage besetzt.
    // Seit 3.0.5 steht der Satz EINMAL, in `emptyList`, und beide Listen
    // zeigen ihn nur hinter dem Gate: die lokale direkt, die Cloud-Liste ueber
    // `loading`, das CloudModelPicker vor `empty` prueft.
    expect(SELECTOR.split('No models available</p>').length - 1).toBe(1)
    const at = SELECTOR.indexOf('const emptyList = (')
    expect(at).toBeGreaterThan(0)
    expect(SELECTOR.indexOf('No models available</p>', at) - at).toBeLessThan(200)
    expect(SELECTOR.split('emptyList').length - 1, 'emptyList wird an genau zwei Stellen gezeigt').toBe(3)
    expect(SELECTOR).toContain('{inventoryLoaded && textModels.length === 0 && emptyList}')
    expect(SELECTOR).toContain('loading={!inventoryLoaded}')
    expect(SELECTOR).toContain('empty={emptyList}')
    expect(CLOUD_PICKER).toContain('{!loading && rows.length === 0 && empty}')
  })

  it('das Signal kommt aus dem Store, nicht aus einem zweiten lokalen Flag', () => {
    expect(SELECTOR).toContain('useModelStore((s) => s.inventoryLoaded)')
  })
})

describe('die Skelette tragen die Geometrie der Liste, die kommt', () => {
  it('das Raster-Skelett benutzt dieselbe Rasterzeile wie Discover', () => {
    // Zwei Spalten erst ab lg: bei 900 px stand "Start here" zweispaltig
    // ueber einem einspaltigen Raster, und das Skelett sprang beim Eintreffen
    // der Liste von zwei Spalten auf eine. Discover kennt nur noch diese eine
    // Rasterzeile.
    const grid = 'grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-2.5'
    expect(DISCOVER).toContain(grid)
    expect(DISCOVER).not.toContain('md:grid-cols-2')
    for (const name of RASTER_SKELETTE) expect(skeleton(name), name).toContain(grid)
  })

  it('welches Raster-Skelett steht, entscheidet dieselbe Stelle wie bei der Kachel', () => {
    const wahl = skeleton('ModelGridSkeleton')
    expect(wahl).toMatch(/modelSkinName\(\) === 'mac' \? <ModelGridSkeletonMac \/> : <ModelGridSkeletonClassic \/>/)
    expect(SKELETONS).toContain("import { modelSkinName } from '../models/skin/which'")
    // Und nirgends sonst in der Datei wird nach der Plattform gefragt.
    expect(SKELETONS).not.toMatch(/isMacOS|navigator\./)
  })

  it('die Kachel-Huelle stimmt mit der echten Kachel ueberein', () => {
    // Die echte Kachel steht in ModelTiles.tsx. Radius und Rand schreibt sie
    // seit dem Redesign vom Oktober 2026 nicht mehr selbst aus, sie traegt die
    // Hausflaeche `.lu-tile` (index.css) und p-3.5. Das Skelett muss dieselbe
    // Flaeche und dasselbe Mass tragen, sonst springt die Kachel beim Laden.
    const tile = read('components', 'models', 'ModelTiles.tsx')
    expect(tile).toMatch(/lu-tile relative flex h-full flex-col p-3\.5/)
    const s = skeleton('ModelGridSkeletonMac')
    expect(s).toContain('lu-tile')
    expect(s).toContain('p-3.5')
    expect(s).not.toContain('rounded-xl border')
  })

  it('die klassische Kachel-Huelle stimmt mit der klassischen Kachel ueberein', () => {
    // Windows und Linux: das Mass von vor dem Redesign (p-3), die Flaeche
    // seit dem 10.10.2026 dieselbe wie auf dem Mac (`.lu-tile`).
    const tile = read('components', 'models', 'skin', 'ClassicTiles.tsx')
    expect(tile).toMatch(/'lu-tile relative p-3'/)
    const s = skeleton('ModelGridSkeletonClassic')
    expect(s).toContain('lu-tile')
    expect(s).toMatch(/(?<![\w.-])p-3(?![\w.-])/)
    expect(s).not.toContain('p-3.5')
  })

  it('die CivitAI-Zeile stimmt in Polsterung, Radius und Thumbnail-Mass', () => {
    expect(CIVITAI).toContain('flex gap-3 p-3 rounded-lg')
    expect(CIVITAI).toContain('w-14 h-14 rounded-lg')
    const s = skeleton('CivitaiResultsSkeleton')
    expect(s).toContain('flex gap-3 p-3 rounded-lg')
    expect(s).toContain('w-14 h-14 rounded-lg')
  })

  it('die Waehler-Zeile stimmt in Polsterung', () => {
    expect(SELECTOR).toContain('px-2.5 py-[5px] mx-1')
    expect(skeleton('ModelPickerSkeleton')).toContain('px-2.5 py-[5px] mx-1')
  })

  it('die Import-Zeile stimmt im Zeilenabstand', () => {
    expect(SETTINGS).toContain('<div className="space-y-1">')
    expect(skeleton('ImportScanSkeleton')).toContain('space-y-1')
  })
})

describe('die Skelette sagen, dass sie Ladezustaende sind', () => {
  const NAMES = [
    ...RASTER_SKELETTE,
    'CivitaiResultsSkeleton',
    'ModelPickerSkeleton',
    'ImportScanSkeleton',
  ]

  it.each(NAMES)('%s haengt in der ListShell', (name) => {
    expect(skeleton(name)).toContain('<ListShell label=')
  })

  it('die ListShell meldet role/aria und einen Text fuer Screenreader', () => {
    const shell = SKELETONS.slice(
      SKELETONS.indexOf('function ListShell('),
      SKELETONS.indexOf('export function SettingsSkeleton'),
    )
    expect(shell).toContain('role="status"')
    expect(shell).toContain('aria-busy="true"')
    expect(shell).toContain('aria-live="polite"')
    expect(shell).toContain('className="sr-only"')
  })

  it('und sie STRECKT sich nicht — h-full gehoert nur den View-Fallbacks', () => {
    const shell = SKELETONS.slice(
      SKELETONS.indexOf('function ListShell('),
      SKELETONS.indexOf('export function SettingsSkeleton'),
    )
    expect(shell).not.toContain('h-full')
    // Die View-Fallbacks brauchen es weiterhin.
    const viewShell = SKELETONS.slice(
      SKELETONS.indexOf('function Shell('),
      SKELETONS.indexOf('function ListShell('),
    )
    expect(viewShell).toContain('h-full')
  })
})

describe('die Bewegung erbt die Ausnahme, statt eine neue zu brauchen', () => {
  it('alle Skelette pulsen mit `animate-pulse`, keins bringt ein eigenes Keyframe mit', () => {
    expect(SKELETONS).toContain('animate-pulse')
    // Ein eigenes `@keyframes` in dieser Datei gaebe es gar nicht — aber ein
    // eigener Klassenname, der in index.css ein Keyframe bekaeme, schon.
    expect(SKELETONS).not.toMatch(/animation|keyframes|lu-skeleton|shimmer/i)
  })

  it('und index.css nimmt `animate-pulse` ausdruecklich von der Kuerzung aus', () => {
    // Ohne diese Ausnahme wuerde die Regel darueber
    // (`animation-iteration-count: 1`) das Skelett nach einem Durchlauf
    // einfrieren — und ein eingefrorenes Skelett sagt „fertig, aber leer".
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/)
    const pulse = block.match(/\.animate-pulse\s*\{[^}]*\}/)?.[0] ?? ''
    expect(pulse).toMatch(/animation-iteration-count:\s*infinite\s*!important/)
    expect(pulse).toMatch(/animation-duration:\s*3s\s*!important/)
  })
})
