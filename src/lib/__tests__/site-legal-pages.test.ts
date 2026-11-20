/**
 * The three legal pages of locallyuncensored.com: privacy, terms, impressum.
 *
 * What this file holds:
 *
 * 1. No page under docs/ goes out with an open question in it. A text that
 *    waits for a fact carries a marker in square brackets, and this test is
 *    red for as long as one stands. That is on purpose: the branch may wait,
 *    the public site may not show a gap.
 * 2. The date of the two dated pages is written by
 *    scripts/site-publish-date.mjs on the day of publication. Until then the
 *    pages carry a comment and show no date at all, so nothing false can go
 *    out if the step is forgotten.
 * 3. The legal pages are linked from the home page, stay out of the search
 *    index and out of the sitemap, like /terms and /privacy at lu-labs.ai.
 *
 * Run: npx vitest run src/lib/__tests__/site-legal-pages.test.ts
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DATED_PAGES,
  DATE_LINE,
  DATE_MARKER,
  OPEN_PLACEHOLDER,
  bumpSitemap,
  dateLine,
  longDate,
  stamp,
  urlOf,
} from '../../../scripts/site-publish-date.mjs'

const ROOT = resolve(__dirname, '../../..')
const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8')
const LEGAL = ['privacy', 'terms', 'impressum']

function docsTextFiles(): string[] {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z', 'docs'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((file) => /\.(html|txt|md|json|xml)$/.test(file))
}

describe('no page goes out with an open question', () => {
  it('finds a placeholder when one is set', () => {
    expect('kept for [TO CONFIRM: how long] and [MAC: file name]'.match(OPEN_PLACEHOLDER)).toHaveLength(2)
    expect('a [link](target) and an [x] box'.match(OPEN_PLACEHOLDER)).toBeNull()
  })

  it('docs/ carries no open placeholder', () => {
    const open: string[] = []
    for (const file of docsTextFiles()) {
      for (const found of read(file).match(OPEN_PLACEHOLDER) ?? []) open.push(`${file}: ${found}`)
    }
    expect(
      open,
      'A page still waits for a fact. Fill it in before the site goes out. ' +
        'For the retention period of the page view data, the two prepared wordings are in ' +
        '~/Desktop/LU/lu-306-texte/seite/ (aufbewahrung-einsetzen.sh).',
    ).toEqual([])
  })
})

describe('the date of the dated pages', () => {
  it('writes the date in the form the terms at lu-labs.ai use', () => {
    expect(longDate('2026-10-13')).toBe('13 October 2026')
    expect(longDate('2026-01-05')).toBe('5 January 2026')
    expect(() => longDate('13.10.2026')).toThrow()
    expect(() => longDate('2026-13-01')).toThrow()
  })

  it('replaces the marker, and on a second run the date', () => {
    const waiting = '<h1>Privacy</h1>\n<!-- LAST-UPDATED: written on the day -->\n<nav>'
    const once = stamp(waiting, '2026-10-13')
    expect(once).toContain('<p class="small">Last updated: <time datetime="2026-10-13">13 October 2026</time></p>')
    expect(DATE_MARKER.test(once)).toBe(false)
    expect(stamp(once, '2026-10-14')).toBe(waiting.replace(DATE_MARKER, dateLine('2026-10-14')))
    expect(() => stamp('<h1>no marker</h1>', '2026-10-13')).toThrow()
  })

  it('each dated page carries the marker or a date, and both carry the same', () => {
    const states = DATED_PAGES.map((page: string) => {
      const html = read(page)
      const line = DATE_LINE.exec(html)
      const marker = DATE_MARKER.test(html)
      expect(marker !== Boolean(line), `${page}: exactly one of marker and date line`).toBe(true)
      if (line) expect(line[2], `${page}: the written date and its datetime disagree`).toBe(longDate(line[1]))
      return line ? line[1] : 'waiting'
    })
    expect(new Set(states).size, `the dated pages disagree: ${states.join(', ')}`).toBe(1)
  })

  it('no dated page shows a date that was typed by hand', () => {
    for (const page of DATED_PAGES) {
      const html = read(page).replace(DATE_LINE, '')
      expect(/Last updated/i.test(html), `${page}: a second "Last updated" outside the written line`).toBe(false)
    }
  })

  it('maps a file to its address and moves only the lastmod of that address', () => {
    expect(urlOf('docs/index.html')).toBe('https://locallyuncensored.com/')
    expect(urlOf('docs/cloud/index.html')).toBe('https://locallyuncensored.com/cloud/')
    expect(urlOf('docs/blog/a.html')).toBe('https://locallyuncensored.com/blog/a.html')
    const xml =
      '<url><loc>https://locallyuncensored.com/</loc><lastmod>2026-10-05</lastmod></url>\n' +
      '<url><loc>https://locallyuncensored.com/cloud/</loc><lastmod>2026-09-22</lastmod></url>\n'
    const out = bumpSitemap(xml, ['docs/cloud/index.html', 'docs/not-listed/index.html'], '2026-10-13')
    expect(out.bumped).toBe(1)
    expect(out.xml).toContain('/cloud/</loc><lastmod>2026-10-13</lastmod>')
    expect(out.xml).toContain('.com/</loc><lastmod>2026-10-05</lastmod>')
    const spread = '<url>\n    <loc>https://locallyuncensored.com/cloud/</loc>\n    <lastmod>2026-09-22</lastmod>\n  </url>'
    expect(bumpSitemap(spread, ['docs/cloud/index.html'], '2026-10-13').xml).toBe(spread.replace('2026-09-22', '2026-10-13'))
  })

  it('every entry of the sitemap has the shape the step relies on', () => {
    const entries = read('docs/sitemap.xml').match(/<url>[\s\S]*?<\/url>/g) ?? []
    expect(entries.length).toBeGreaterThan(100)
    for (const entry of entries) {
      expect(entry, entry.slice(0, 120)).toMatch(/<loc>https:\/\/locallyuncensored\.com\/[^<]*<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/)
    }
  })
})

describe('the legal pages are reachable and stay out of the index', () => {
  const sitemap = read('docs/sitemap.xml')
  const home = read('docs/index.html')

  for (const name of LEGAL) {
    it(`${name}: noindex, own canonical, linked from the home page, not in the sitemap`, () => {
      const html = read(`docs/${name}/index.html`)
      expect(html).toContain('<meta name="robots" content="noindex, follow">')
      expect(html).toContain(`<link rel="canonical" href="https://locallyuncensored.com/${name}/">`)
      expect(home).toContain(`href="https://locallyuncensored.com/${name}/"`)
      expect(sitemap).not.toContain(`https://locallyuncensored.com/${name}/`)
    })
  }

  it('robots.txt does not lock them away, or the noindex would never be read', () => {
    expect(read('docs/robots.txt')).not.toMatch(/^Disallow:\s*\/(privacy|terms|impressum)/m)
  })

  it('impressum and privacy page name the same provider', () => {
    const impressum = read('docs/impressum/index.html')
    const privacy = read('docs/privacy/index.html')
    for (const part of ['David Drobnitza', '41747 Viersen']) {
      expect(impressum).toContain(part)
      expect(privacy).toContain(part)
    }
  })
})
