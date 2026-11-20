/**
 * Which shape LU's window has while computer control works, and when the
 * edge of the display glows.
 *
 * The rule that must never break: the glow is up exactly while computer
 * control is busy. No shape of the window in which something runs without
 * the glow, and no glow with nothing running.
 *
 * Run: npx vitest run src/lib/computer/__tests__/surface.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRIP_DRAG_MIN, HOME_CORNER, PANEL_MARGIN, PANEL_SIZE, PAUSE_LAYOUT, coveredSentence, grippedCorner, panelPlace, wantedSurface } from '../surface'
import type { PanelCorner } from '../../../api/computer'
import type { SurfaceFacts } from '../surface'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const every: SurfaceFacts[] = []
for (const busy of [false, true]) for (const stopped of [false, true]) for (const asking of [false, true]) for (const paused of [false, true]) {
  every.push({ busy, stopped, asking, paused })
}

describe('the glow and the work', () => {
  it.each(every)('busy $busy, stopped $stopped, asking $asking, paused $paused', (facts) => {
    const wanted = wantedSurface(facts)
    const running = !facts.stopped && (facts.busy || facts.asking || facts.paused)
    // The glow follows the work and nothing else.
    expect(wanted.active).toBe(running)
    // A window that is not the ordinary one exists only while something runs.
    if (!running) expect(wanted).toEqual({ mode: 'window', active: false, focus: false })
    else expect(wanted.mode).not.toBe('window')
  })

  it('a session that waits for an answer keeps the glow', () => {
    expect(wantedSurface({ busy: false, stopped: false, asking: true, paused: false }).active).toBe(true)
    expect(wantedSurface({ busy: false, stopped: false, asking: false, paused: true }).active).toBe(true)
  })

  it('a stop takes everything down at once, whatever else is open', () => {
    for (const facts of every.filter((f) => f.stopped)) expect(wantedSurface(facts).mode).toBe('window')
  })
})

describe('the shape of the window', () => {
  it('is the panel while the agent has the mouse, and the panel takes no focus', () => {
    expect(wantedSurface({ busy: true, stopped: false, asking: false, paused: false })).toEqual({ mode: 'panel', active: true, focus: false })
  })

  it('is the same panel for a question, without taking the focus from the app LU works in', () => {
    expect(wantedSurface({ busy: true, stopped: false, asking: true, paused: false })).toEqual({ mode: 'panel', active: true, focus: false })
  })

  it('is the same panel while the user decides about a pause, before any question, and now it takes the keyboard', () => {
    expect(wantedSurface({ busy: true, stopped: false, asking: true, paused: true })).toEqual({ mode: 'panel', active: true, focus: true })
  })

  it('there is no shape but the panel while something runs: nothing can jump between two', () => {
    for (const facts of every) {
      const wanted = wantedSurface(facts)
      if (wanted.active) expect(wanted.mode).toBe('panel')
    }
  })

  it('one switch moves the paused view from the panel to the whole display', () => {
    expect(PAUSE_LAYOUT).toBe('panel')
    const facts = { busy: true, stopped: false, asking: false, paused: true }
    expect(wantedSurface(facts, 'fullscreen')).toEqual({ mode: 'pause', active: true, focus: true })
    expect(wantedSurface(facts, 'panel')).toEqual({ mode: 'panel', active: true, focus: true })
  })
})

describe('the page that draws the glow', () => {
  const page = read('public/computer-glow.html')

  it('uses the accent of the app', () => {
    const token = /--color-lu-accent:\s*#([0-9a-f]{6});/i.exec(read('src/index.css'))
    expect(token).not.toBeNull()
    const hex = token![1]
    const rgb = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')
    expect(page).toContain(`--accent: ${rgb};`)
  })

  it('runs no script, catches no click and stands still for reduced motion', () => {
    expect(page).not.toMatch(/<script/i)
    expect(page).not.toMatch(/\son[a-z]+=/i)
    expect(page).toContain('pointer-events: none')
    expect(page).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/)
  })

  it('is shown in a window that holds no permission at all', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/computer-glow.json'))
    expect(capability.windows).toEqual(['computer-glow'])
    expect(capability.permissions).toEqual([])
    // The main capability does not reach the glow window either.
    expect(JSON.parse(read('src-tauri/capabilities/default.json')).windows).toEqual(['main'])
  })

  it('and Rust makes that window click-through before it shows it', () => {
    const rust = read('src-tauri/src/commands/computer/surface.rs')
    const through = rust.indexOf('window.set_ignore_cursor_events(true).is_err()')
    const shown = rust.indexOf('let _ = window.show();')
    expect(through).toBeGreaterThan(0)
    expect(shown).toBeGreaterThan(through)
    expect(rust).toContain('.focusable(false)')
    expect(rust).toContain('.content_protected(true)')
    expect(rust).toContain('.skip_taskbar(true)')
  })
})

describe('the sizes Rust and the interface agree on', () => {
  it('the panel and its distance from the edges, each written once on either side', () => {
    const rust = read('src-tauri/src/commands/computer/surface.rs')
    expect(rust).toContain(`pub const PANEL_SIZE: (f64, f64) = (${PANEL_SIZE.width}.0, ${PANEL_SIZE.height}.0);`)
    expect(rust).toContain(`pub const MARGIN: f64 = ${PANEL_MARGIN}.0;`)
    // The view draws to the numbers of the library and names none of its own.
    const view = read('src/components/computer/ComputerSurface.tsx')
    expect(view).toContain("import { PANEL_MARGIN, PANEL_SIZE, PAUSE_LAYOUT, grippedCorner, panelPlace } from '../../lib/computer/surface'")
    expect(view).not.toMatch(/width: \d|height: \d/)
  })

  it('Rust knows no shape but the panel, the paused view and the window', () => {
    const rust = read('src-tauri/src/commands/computer/surface.rs')
    const modes = /pub enum Mode \{([\s\S]*?)\n\}/.exec(rust)![1].split('\n').map((line) => line.trim()).filter((line) => /^[A-Z]\w*,$/.test(line))
    expect(modes).toEqual(['Window,', 'Panel,', 'Pause,'])
    // The panel takes clicks at any time, so Pause and Stop are in reach.
    expect(rust).not.toContain('set_ignore_cursor_events(pill)')
  })
})

describe('the corner of the panel', () => {
  const corners: PanelCorner[] = ['top_right', 'bottom_right', 'bottom_left', 'top_left']
  const far = GRIP_DRAG_MIN + 40

  it('a press on the grip names no corner, and a few pixels of a shaky hand are a press', () => {
    for (const from of corners) {
      expect(grippedCorner(from, 0, 0)).toBeNull()
      expect(grippedCorner(from, GRIP_DRAG_MIN - 1, -(GRIP_DRAG_MIN - 1))).toBeNull()
    }
  })

  it('a drag toward a side sends the panel to the corner on that side', () => {
    expect(grippedCorner('top_right', -far, 0)).toBe('top_left')
    expect(grippedCorner('top_right', 0, far)).toBe('bottom_right')
    expect(grippedCorner('top_right', -far, far)).toBe('bottom_left')
    expect(grippedCorner('bottom_left', far, -far)).toBe('top_right')
    expect(grippedCorner('bottom_left', far, 3)).toBe('bottom_right')
    expect(grippedCorner('top_left', 5, far)).toBe('bottom_left')
  })

  it('a drag toward the side the panel is on already moves nothing', () => {
    expect(grippedCorner('top_right', far, 0)).toBe('stay')
    expect(grippedCorner('top_right', far, -far)).toBe('stay')
    expect(grippedCorner('bottom_left', -far, far)).toBe('stay')
  })

  it('from every corner every other one is one drag away', () => {
    for (const from of corners) {
      const reached = new Set<unknown>()
      for (const dx of [-far, 0, far]) for (const dy of [-far, 0, far]) reached.add(grippedCorner(from, dx, dy))
      for (const to of corners.filter((c) => c !== from)) expect(reached.has(to)).toBe(true)
    }
  })

  it('on a page the panel keeps its distance from the edges in each corner', () => {
    const unit = (n: number) => `${n}px`
    expect(panelPlace('top_right', unit)).toEqual({ left: `calc(100% - ${PANEL_SIZE.width + PANEL_MARGIN}px)`, top: `${PANEL_MARGIN}px` })
    expect(panelPlace('top_left', unit)).toEqual({ left: `${PANEL_MARGIN}px`, top: `${PANEL_MARGIN}px` })
    expect(panelPlace('bottom_left', unit)).toEqual({ left: `${PANEL_MARGIN}px`, top: `calc(100% - ${PANEL_SIZE.height + PANEL_MARGIN}px)` })
    expect(panelPlace('bottom_right', unit)).toEqual({ left: `calc(100% - ${PANEL_SIZE.width + PANEL_MARGIN}px)`, top: `calc(100% - ${PANEL_SIZE.height + PANEL_MARGIN}px)` })
  })

  it('Rust and the interface name the same four corners and start in the same one', () => {
    const rust = read('src-tauri/src/commands/computer/surface.rs')
    const variants = /pub enum Corner \{([\s\S]*?)\n\}/.exec(rust)![1]
    const names = [...variants.matchAll(/^\s*([A-Z]\w*),$/gm)].map((m) => m[1].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase())
    expect(names).toEqual(corners)
    expect(/#\[default\]\s+(\w+),/.exec(variants)![1]).toBe('TopRight')
    expect(HOME_CORNER).toBe('top_right')
    expect(read('src/stores/computerStore.ts')).toContain('corner: HOME_CORNER,')
  })

  it('the corner is the grip\'s to change: nothing else in the interface moves the panel', () => {
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (/\.tsx?$/.test(entry.name) && /\bmoveComputerPanel\(/.test(read(path))) callers.push(path)
      }
    }
    walk('src')
    expect(callers).toEqual(['src/components/computer/ComputerSurface.tsx'])
    // No tool of the model reaches it either: the tool knows no such action.
    const tool = read('src/api/computer-use.ts')
    expect(tool).not.toContain('moveComputerPanel')
    expect(tool).not.toContain('computer_surface_corner')
  })
})

describe('what the model is told about the part of the picture the panel hides', () => {
  it('names the area on the grid and the way to get at what is under it', () => {
    const sentence = coveredSentence([[796, 11, 994, 456]])
    expect(sentence).toContain('from 796, 11 to 994, 456')
    expect(sentence).toContain("LU's own panel")
    expect(sentence).toContain('click where it should be')
    expect(sentence).toContain('new picture')
  })

  it('says nothing when nothing of LU is in the picture', () => {
    expect(coveredSentence([])).toBeNull()
    expect(coveredSentence(undefined)).toBeNull()
    expect(coveredSentence([[1, 2, 3]])).toBeNull()
  })

  it('takes two pieces of the same window as one area', () => {
    expect(coveredSentence([[800, 10, 900, 400], [900, 10, 990, 450]])).toContain('from 800, 10 to 990, 450')
  })
})
