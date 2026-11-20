/**
 * @vitest-environment jsdom
 *
 * The build of the redesigned Model Manager is for the Mac only. Its colours
 * are for everyone.
 *
 * 08.10.2026: the new design is the Mac's alone, Windows and Linux keep the
 * page as it was. 10.10.2026: that page read as too grey, so the classic face
 * now wears exactly the Mac's colours (one accent, the tile surface and the
 * tinted Get of the house) and keeps its own build, measures and behaviour.
 *
 * The page has two faces (skin/classic.tsx, skin/mac.tsx) and one place that
 * picks between them (skin/which.ts). This file nails down four things:
 *
 *   1. Which face a platform gets, asked the way the app asks it: through
 *      `navigator`, with nothing mocked in between.
 *   2. That the face really reaches the screen: the page, a tile, an
 *      installed row and the loading skeleton are rendered per platform and
 *      carry the marks of their face and none of the other one.
 *   3. That the choice cannot be bypassed: nothing outside skin/ reaches for
 *      one face directly, and nothing else asks the platform to pick a look.
 *   4. That the classic face is the classic BUILD in the Mac's COLOURS: it
 *      carries none of the measures and pieces of the redesign, and none of
 *      the greys and per-type colours it used to spell by hand.
 *
 * Pictures of the classic face: proof/design-pill/win/model-manager/.
 *
 * Run: npx vitest run src/components/models/__tests__/das-neue-design-ist-nur-fuer-den-mac.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { MessagesSquare, Images } from 'lucide-react'
import type { DiscoverModel } from '../../../api/discover'
import type { AIModel } from '../../../types/models'

// The Mac face reads the machine's memory for the foot of its rail. Silent
// here: this file is about which face is drawn, not about the reading.
vi.mock('../../../hooks/useGraphicsMemory', () => ({ useGraphicsMemoryGb: () => 32 }))
vi.mock('../../../lib/hardware', async (orig) => ({
  ...(await orig<typeof import('../../../lib/hardware')>()),
  getTotalRamGb: vi.fn(async () => 32),
}))

import { modelSkin } from '../skin'
import { modelSkinName } from '../skin/which'
import { classicSkin } from '../skin/classic'
import { macSkin } from '../skin/mac'
import { ModelCard } from '../ModelCard'
import { ModelGridSkeleton } from '../../layout/ViewSkeletons'

/** What a WebView reports on each system the app ships for. */
const PLATFORMS = {
  windows: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0' },
  linux: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
  mac: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' },
} as const
type Platform = keyof typeof PLATFORMS

const real = {
  platform: Object.getOwnPropertyDescriptor(navigator, 'platform'),
  userAgent: Object.getOwnPropertyDescriptor(navigator, 'userAgent'),
}
function be(p: Platform) {
  Object.defineProperty(navigator, 'platform', { get: () => PLATFORMS[p].platform, configurable: true })
  Object.defineProperty(navigator, 'userAgent', { get: () => PLATFORMS[p].userAgent, configurable: true })
}
afterEach(() => {
  cleanup()
  for (const key of ['platform', 'userAgent'] as const) {
    if (real[key]) Object.defineProperty(navigator, key, real[key]!)
    else delete (navigator as unknown as Record<string, unknown>)[key]
  }
})

const EXPECTED: Record<Platform, 'classic' | 'mac'> = { windows: 'classic', linux: 'classic', mac: 'mac' }

/** The build of the redesign: the measures and pieces only the Mac face has.
 *  The padded tile that fills its grid cell, the rail entry with the accent
 *  bar, the underlined tabs, the icon button of the house, the size as text. */
const MAC_BUILD = /p-3\.5|h-full flex-col|border-l-2|border-b-2|lg:w-44|control-h-md|lu-control--icon|data-tile-size/
/** The colours the classic face spelled by hand until 10.10.2026: a colour
 *  per type, the blue ring, the white and the black button, the red hover of Delete. The red of a
 *  failed bundle's Retry is not among them: it means broken on both faces. */
const OLD_COLOURS = /(?:blue|purple|green)-\d00|ring-blue|bg-white dark:bg-white\/10|bg-gray-900|hover:bg-red-500\/20|hover:text-red-|shadow-sm/

describe('which face a platform gets', () => {
  it.each(Object.keys(PLATFORMS) as Platform[])('%s', (p) => {
    be(p)
    expect(modelSkinName()).toBe(EXPECTED[p])
    expect(modelSkin()).toBe(EXPECTED[p] === 'mac' ? macSkin : classicSkin)
    expect(modelSkin().name).toBe(EXPECTED[p])
  })

  it('the two faces are two different sets of pieces', () => {
    for (const key of ['ManagerFrame', 'QuietLine', 'EmptyState', 'Head', 'FilterBar', 'ModelTile', 'BundleTile', 'LoraManager'] as const) {
      expect(classicSkin[key], key).not.toBe(macSkin[key])
    }
  })
})

const MODEL: DiscoverModel = {
  name: 'Solo 7B', description: 'Solo 7B · a model', pulls: '120k', tags: ['Q4_K_M'], updated: '', sizeGB: 7,
}
const ROW = {
  name: 'openai::Phi-4-mini-instruct-Q4_K_M', model: 'Phi-4-mini-instruct-Q4_K_M', size: 2_500_000_000,
  type: 'text', provider: 'openai', providerName: 'LU Engine',
} as unknown as AIModel

function frame() {
  const skin = modelSkin()
  return render(createElement(skin.ManagerFrame, {
    rail: 'text',
    entries: [
      { key: 'text', label: 'Chat', Icon: MessagesSquare, active: true, badge: { kind: 'count', value: 3 } as never, onPick: () => {} },
      { key: 'image', label: 'Image', Icon: Images, active: false, badge: { kind: 'count', value: 0 } as never, onPick: () => {} },
    ],
    onBack: () => {},
    tab: 'discover',
    onTab: () => {},
    installedBadge: { kind: 'count', value: 3 } as never,
    searchRef: { current: null },
    search: { value: '', onChange: () => {}, onKeyDown: () => {} },
    onRefresh: () => {},
    onPull: () => {},
    children: createElement('div', { 'data-testid': 'view' }),
  }))
}

describe.each(['windows', 'linux'] as const)('%s draws the classic build in the colours of the Mac', (p) => {
  beforeEach(() => be(p))

  it('the frame: one top bar with "Models" and the segmented Get new / Installed', () => {
    const { container } = frame()
    expect(container.querySelector('h1')?.textContent).toBe('Models')
    // BUILD. The switch stands in the top bar, in its track, with its glyphs.
    const views = container.querySelector('[data-models-view]')!
    expect(views.className).toContain('p-0.5 rounded-lg bg-gray-100')
    expect(views.parentElement?.querySelector('h1')).not.toBeNull()
    expect(views.textContent).toContain('Get new')
    expect(views.querySelectorAll('svg')).toHaveLength(2)
    // The rail is the wide one with the boxed selection and no foot reading.
    const aside = container.querySelector('aside')!
    expect(aside.className).toContain('lg:w-36')
    expect(aside.getAttribute('aria-label')).toBeNull()
    expect(aside.textContent).not.toContain('Library')
    expect(aside.textContent).toContain('Models run 100% on your computer.')
    const picked = aside.querySelector('button[aria-pressed="true"]')!
    expect(picked.className).toContain('px-2 py-2 rounded-lg border ')
    // Back is in the top bar, not in the rail.
    expect(aside.querySelector('button[title="Back to chat"]')).toBeNull()
    expect(container.querySelector('[data-testid="models-pane"] button[title="Back to chat"]')).not.toBeNull()
    expect(container.innerHTML).not.toMatch(MAC_BUILD)

    // COLOURS. The selection is the accent pair, on the rail and on the switch.
    expect(picked.className).toContain('bg-lu-accent-soft border-lu-accent-edge dark:border-lu-accent-ring')
    expect(picked.querySelector('svg')!.getAttribute('class')).toContain('text-lu-accent-ink dark:text-lu-accent')
    const [open, closed] = [...views.querySelectorAll('button')]
    expect(open.className).toContain('bg-lu-accent-soft ring-1 ring-inset ring-lu-accent-edge')
    expect(closed.className).not.toContain('lu-accent')
    // The rest of the rail has no accent and no fill of its own.
    expect(aside.querySelector('button[aria-pressed="false"]')!.className).not.toContain('lu-accent')
    expect(aside.className).not.toMatch(/(?<![\w:-])bg-/)
    expect(container.innerHTML).not.toMatch(OLD_COLOURS)
  })

  it('a chat tile: the classic measure on the house surface, with the tinted Get', () => {
    const html = renderToStaticMarkup(createElement(modelSkin().ModelTile, {
      variants: [MODEL], vramGb: 12, isInstalled: () => false, dlState: () => null,
      onDownload: () => {}, onInfo: () => {}, onOpenUrl: () => {},
    }))
    expect(html).toContain('<div class="lu-tile relative p-3" data-model-tile')
    // The size is still the pill, in the one row with the verdict and Get.
    expect(html).toMatch(/<span class="t-micro px-1\.5 py-0\.5 rounded-md bg-gray-100[^"]*">7 GB<\/span>/)
    expect(html).toContain('<button class="lu-tonal" title="Download 7 GB">')
    expect(html).not.toMatch(MAC_BUILD)
    expect(html).not.toMatch(OLD_COLOURS)
  })

  it('an installed row: the classic row, the accent on the one in use, one tone for every type', () => {
    const row = (model: AIModel, isActive: boolean) => renderToStaticMarkup(createElement(ModelCard, {
      model, isActive, onSelect: () => {}, onDelete: () => {}, onInfo: () => {},
    }))
    const html = row(ROW, true)
    expect(html).toContain('lu-tile rounded-lg! flex items-center gap-2.5 px-3 py-1.5 cursor-pointer group lu-tile--active')
    expect(html).toContain('shrink-0 text-lu-accent-ink dark:text-lu-accent')
    expect(html).not.toMatch(MAC_BUILD)
    expect(html).not.toMatch(OLD_COLOURS)
    const resting = row(ROW, false)
    expect(resting).not.toContain('lu-tile--active')
    expect(resting).not.toMatch(OLD_COLOURS)
    // An image model wears the same glyph tone as a chat model.
    const image = row({ ...ROW, type: 'image' } as AIModel, false)
    expect(image).toContain('shrink-0 text-gray-400 dark:text-gray-500')
    expect(image).not.toMatch(OLD_COLOURS)
  })

  it('the loading skeleton: the measure of the classic tile on the house surface', () => {
    const html = renderToStaticMarkup(createElement(ModelGridSkeleton))
    expect(html).toContain('class="lu-tile pointer-events-none p-3"')
    expect(html).not.toMatch(MAC_BUILD)
  })
})

describe('macOS draws the redesign', () => {
  beforeEach(() => be('mac'))

  it('the frame: the lane as the heading, text tabs, the narrow rail with its foot', () => {
    const { container } = frame()
    expect(container.querySelector('h1')?.textContent).toBe('Chat models')
    const views = container.querySelector('[data-models-view]')!
    expect(views.className).toContain('border-b')
    expect(views.querySelectorAll('svg')).toHaveLength(0)
    const aside = container.querySelector('aside')!
    expect(aside.getAttribute('aria-label')).toBe('Model lanes')
    expect(aside.className).toContain('lg:w-44')
    expect(aside.textContent).toContain('Library')
    expect(aside.textContent).toContain('This Mac')
    expect(aside.querySelector('button[title="Back to chat"]')).not.toBeNull()
    expect(aside.querySelector('button[aria-pressed="true"]')!.className).toContain('bg-lu-accent-soft')
  })

  it('a chat tile: the house surface and the tinted Get', () => {
    const html = renderToStaticMarkup(createElement(modelSkin().ModelTile, {
      variants: [MODEL], vramGb: 12, isInstalled: () => false, dlState: () => null,
      onDownload: () => {}, onInfo: () => {}, onOpenUrl: () => {},
    }))
    expect(html).toContain('class="lu-tile relative flex h-full flex-col p-3.5 ')
    expect(html).toContain('<button class="lu-tonal" title="Download 7 GB">')
    expect(html).not.toContain('rounded-xl border')
  })

  it('an installed row: the house surface with the accent on the one in use', () => {
    const html = renderToStaticMarkup(createElement(ModelCard, {
      model: ROW, isActive: true, onSelect: () => {}, onDelete: () => {}, onInfo: () => {},
    }))
    expect(html).toContain('lu-tile flex items-center gap-3 px-3.5 py-2 cursor-pointer group lu-tile--active')
    expect(html).not.toContain('blue-400')
  })

  it('the loading skeleton: the measure of the new tile', () => {
    const html = renderToStaticMarkup(createElement(ModelGridSkeleton))
    expect(html).toContain('lu-tile pointer-events-none p-3.5')
    expect(html).not.toContain('rounded-xl border')
  })
})

// ── The choice cannot be bypassed ───────────────────────────────────

const SRC = resolve(__dirname, '..', '..', '..')
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      sources(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const FILES = sources(SRC).map((f) => ({ name: relative(SRC, f).split('\\').join('/'), code: codeOnly(readFileSync(f, 'utf8')) }))
const importers = (pattern: RegExp) => FILES.filter((f) => pattern.test(f.code)).map((f) => f.name).sort()

describe('one place decides, and nothing goes around it', () => {
  it('the scan sees the page', () => {
    expect(FILES.length).toBeGreaterThan(300)
    expect(FILES.some((f) => f.name === 'components/models/ModelManager.tsx')).toBe(true)
  })

  it('only skin/which.ts turns the platform into a face', () => {
    const which = FILES.find((f) => f.name === 'components/models/skin/which.ts')!.code
    expect(which).toMatch(/return isMacOS\(\) \? 'mac' : 'classic'/)
    // The answer is read in exactly two places: the skin index, and the
    // loading skeleton, which lives in the layout chunk and must not pull the
    // whole page in to know its own geometry.
    expect(importers(/from '(?:[^']*skin\/|\.\/)which'/)).toEqual([
      'components/layout/ViewSkeletons.tsx',
      'components/models/skin/index.ts',
      'components/models/skin/types.ts',
    ])
    expect(FILES.find((f) => f.name === 'components/models/skin/types.ts')!.code).toMatch(/import type \{ ModelSkinName \} from '\.\/which'/)
  })

  it('a face is only ever handed out by the index', () => {
    expect(importers(/from '[^']*skin\/(classic|mac)'|from '\.\/(classic|mac)'/)).toEqual(['components/models/skin/index.ts'])
    expect(importers(/from '[^']*(skin\/|\.\/)Classic(Tiles|LoraManager)'/)).toEqual(['components/models/skin/classic.tsx'])
  })

  it('the pieces that exist in two faces are taken from the face, never directly', () => {
    // The Mac tiles, the Mac list of LoRAs and the layout pieces of the
    // redesign. Whoever imported one of them directly would draw the redesign
    // on Windows again. The Mac media lane and the Mac LoRA lane may: only a
    // Mac ever draws them.
    const macOnly = ['components/models/MacMediaLane.tsx', 'components/models/MacLoraLane.tsx', 'components/models/MacMediaTile.tsx', 'components/models/skin/mac.tsx']
    const direct = FILES.filter((f) =>
      /import \{[^}]*\b(ModelTile|BundleTile|HardwareFoot|TileSize)\b[^}]*\} from '[^']*ModelTiles'/.test(f.code)
      || /import \{[^}]*\bLoraManager\b[^}]*\} from '[^']*LoraManager'/.test(f.code)
      || /from '[^']*ModelPageParts'/.test(f.code),
    ).map((f) => f.name).filter((n) => !macOnly.includes(n) && n !== 'components/models/LoraManager.tsx').sort()
    expect(direct).toEqual([])
  })

  it('the page and its lists ask the face', () => {
    for (const f of ['ModelManager.tsx', 'DiscoverModels.tsx', 'LoraAddons.tsx', 'ModelCard.tsx', 'ModelBenchmark.tsx']) {
      const code = FILES.find((x) => x.name === `components/models/${f}`)!.code
      expect(code, f).toMatch(/import \{ modelSkin[^}]*\} from '\.\/skin'/)
      expect(code, f).toMatch(/modelSkin\(\)/)
    }
  })

  it('the rules stand once: both faces of a tile take them from the same hooks', () => {
    const shared = FILES.find((f) => f.name === 'components/models/ModelTiles.tsx')!.code
    const classic = FILES.find((f) => f.name === 'components/models/skin/ClassicTiles.tsx')!.code
    for (const code of [shared, classic]) {
      expect(code).toMatch(/= useModelTile\(props\)/)
      expect(code).toMatch(/= bundleTileFacts\(props\)/)
    }
    // What decides is not written a second time in the classic face.
    expect(classic).not.toMatch(/modelTileAction|pickDefaultVariant|bundleGetPlan|vramFit\(|useState|useEffect/)
    for (const face of ['classic.tsx', 'ClassicLoraManager.tsx']) {
      const code = FILES.find((f) => f.name === `components/models/skin/${face}`)!.code
      expect(code, face).not.toMatch(/useState|useEffect|backendCall|useModelStore|useDownloadStore|fetch\(/)
    }
  })

  it('the classic face is the classic build: no piece and no measure of the redesign', () => {
    for (const face of ['classic.tsx', 'ClassicTiles.tsx', 'ClassicLoraManager.tsx']) {
      const code = FILES.find((f) => f.name === `components/models/skin/${face}`)!.code
      expect(code, face).not.toMatch(MAC_BUILD)
      expect(code, face).not.toMatch(OLD_COLOURS)
      // A house recipe that brings a height of its own is used only where the
      // classic control already had that height: on the tile, never in the
      // frame or on a row.
      if (face !== 'ClassicTiles.tsx') expect(code, face).not.toMatch(/lu-tonal|lu-control/)
    }
    // The classic tile keeps its pill for the size and its own measure.
    const tiles = FILES.find((f) => f.name === 'components/models/skin/ClassicTiles.tsx')!.code
    expect(tiles).toMatch(/export function SizePill/)
    expect(tiles).not.toMatch(/import \{[^}]*\b(ModelTile|BundleTile|TileSize)\b[^}]*\} from '\.\.\/ModelTiles'/)
  })

  it('the stylesheet gives the new recipes to no one who did not ask', () => {
    // The redesign added rules and changed none: every selector it brought
    // starts with one of its own class names, so a page that does not carry
    // those classes cannot be touched by them. The classic face asks for the
    // colours by name and gets no measure it did not have.
    const css = readFileSync(resolve(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim())
      .flatMap((s) => s.split(',').map((x) => x.trim()))
      .filter((s) => /lu-tile|lu-tonal|lu-control--outline/.test(s))
    expect(selectors.length).toBeGreaterThanOrEqual(15)
    for (const s of selectors) {
      expect(s, s).toMatch(/^(\.light )?\.(lu-tile|lu-tonal|lu-control--outline)(--[a-z]+)?(:[a-z()-]+)*$/)
    }
  })
})
