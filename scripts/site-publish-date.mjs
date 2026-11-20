// Stamps the day the website goes out.
//
// The privacy page and the terms of use say when they were last updated, and
// the sitemap says when a page last changed. Both dates are the day of
// publication, which nobody knows while the branch waits. So the branch
// carries a marker instead of a date, and this script writes the date in as
// the last step before the branch goes to master.
//
//   node scripts/site-publish-date.mjs              today
//   node scripts/site-publish-date.mjs 2026-10-13   a given day
//   node scripts/site-publish-date.mjs --base <ref> compare against another ref
//
// It refuses to run while a page under docs/ still carries an open
// placeholder, so a page with a gap in it does not get a date and go out.
// Running it twice is safe: the second run replaces the first date.
//
// src/lib/__tests__/site-legal-pages.test.ts holds the marker, the date line
// and the placeholder rule.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Pages that carry a "Last updated" line. */
export const DATED_PAGES = ['docs/privacy/index.html', 'docs/terms/index.html']

/** What stands in a dated page until the date is written. */
export const DATE_MARKER = /<!-- LAST-UPDATED: [^>]*-->/
/** The line the script writes, and finds again on a second run. */
export const DATE_LINE = /<p class="small">Last updated: <time datetime="(\d{4}-\d{2}-\d{2})">([^<]+)<\/time><\/p>/
/** An open question in a page. No page goes out with one. */
export const OPEN_PLACEHOLDER = /\[(TO CONFIRM|MAC):[^\]]*\]/g

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-10-13" as "13 October 2026", the form the terms at lu-labs.ai use. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) {
    throw new Error(`not a date in the form YYYY-MM-DD: ${iso}`)
  }
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

export const dateLine = (iso) => `<p class="small">Last updated: <time datetime="${iso}">${longDate(iso)}</time></p>`

/** The page with the date written in. Throws if it has neither marker nor line. */
export function stamp(html, iso) {
  if (DATE_MARKER.test(html)) return html.replace(DATE_MARKER, dateLine(iso))
  if (DATE_LINE.test(html)) return html.replace(DATE_LINE, dateLine(iso))
  throw new Error('the page has neither the date marker nor a date line')
}

/** docs/index.html is "/", docs/a/index.html is "/a/", docs/blog/b.html is "/blog/b.html". */
export function urlOf(file) {
  const path = file.replace(/^docs\//, '').replace(/(^|\/)index\.html$/, '$1')
  return `https://locallyuncensored.com/${path}`
}

// A line that only links the three legal pages from a footer. Every page got
// one, and a new footer link is no reason to tell a crawler the page changed.
const FOOTER_ONLY = /^\s*(<a href="[^"]*\/(privacy|terms|impressum)\/">(Privacy|Terms|Impressum)<\/a>|<\/?footer>|<div class="footer-row footer-links">|<\/div>|(&middot;\s*)?(<a href="\/(privacy|terms|impressum)\/">(Privacy|Terms|Impressum)<\/a>\s*(&middot;)?\s*)+)\s*$/

// The same holds for the frame every page shares: the Pricing link and the
// Cloud button in the header, the footer links to the hosted pages, and the
// breadcrumb block in the head, which repeats the visible trail. A page whose
// only change is its frame keeps its date, so lastmod stays a statement about
// the text. The list of handbook chapters and the one line about LU Cloud at
// the end of a post belong to the frame as well: every post got the same ones.
const FRAME_ONLY = /^\s*(<a class="lu-nav-link" href="\/pricing\/">Pricing<\/a>|<a class="he-cta" href="\/pricing\/".*|<a href="https:\/\/locallyuncensored\.com\/(pricing|cloud|uncensored-ai-chat-online|uncensored-ai-image-generator-online|uncensored-ai-video-generator-online|alternatives|is-locally-uncensored-safe)\/">[^<]*<\/a>|<script type="application\/ld\+json">|<\/script>|\{"@context":"https:\/\/schema\.org","@type":"BreadcrumbList".*|<h2>(In the handbook|More comparisons)<\/h2>|<\/?ul>|<li><a href="\/(guide|alternatives|vs|qwen|deepseek|kimi|blog\/how-to-run-flux-locally)[^"]*">[^<]*<\/a>, [^<]*<\/li>|<p style="margin-top:1[48]px;margin-bottom:0[^"]*">(No GPU\? LU Cloud runs in a browser|Keine GPU\? LU Cloud l&auml;uft im Browser).*)\s*$/

/** Pages under docs/ whose text differs from `base` by more than a footer link. */
export function changedPages(base, root = ROOT) {
  const diff = execFileSync('git', ['-C', root, 'diff', '-U0', base, '--', 'docs'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const pages = new Set()
  let file = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6)
    else if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) continue
    else if (file && /\.html$/.test(file) && /^[+-]/.test(line) && line.slice(1).trim() && !FOOTER_ONLY.test(line.slice(1)) && !FRAME_ONLY.test(line.slice(1))) pages.add(file)
  }
  return [...pages]
}

/** The sitemap with `iso` as lastmod of every listed page in `files`. */
export function bumpSitemap(xml, files, iso) {
  let bumped = 0
  for (const file of files) {
    const loc = `<loc>${urlOf(file)}</loc>`
    const at = xml.indexOf(loc)
    if (at < 0) continue
    // The entries are written on one line or on several, so the date is
    // looked for behind the address, whatever stands between them.
    const rest = xml.slice(at + loc.length)
    const date = /^(\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/.exec(rest)
    if (!date) continue
    xml = xml.slice(0, at + loc.length) + date[1] + iso + date[2] + rest.slice(date[0].length)
    bumped++
  }
  return { xml, bumped }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const baseAt = args.indexOf('--base')
  const base = baseAt >= 0 ? args[baseAt + 1] : 'origin/master'
  const given = args.find((a, i) => /^\d{4}-\d{2}-\d{2}$/.test(a) && i !== baseAt + 1)
  const now = new Date()
  const iso = given ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  longDate(iso)

  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', 'docs'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter((f) => /\.(html|txt|md|json|xml)$/.test(f))
  const open = []
  for (const file of tracked) {
    for (const found of readFileSync(resolve(ROOT, file), 'utf8').match(OPEN_PLACEHOLDER) ?? []) open.push(`${file}: ${found}`)
  }
  if (open.length) {
    process.stderr.write(`Not stamped. ${open.length} open placeholder(s) under docs/:\n${open.map((o) => `  ${o}`).join('\n')}\n`)
    process.exit(1)
  }

  for (const page of DATED_PAGES) {
    const path = resolve(ROOT, page)
    writeFileSync(path, stamp(readFileSync(path, 'utf8'), iso))
    process.stdout.write(`${page}: Last updated: ${longDate(iso)}\n`)
  }
  const sitemapPath = resolve(ROOT, 'docs/sitemap.xml')
  const { xml, bumped } = bumpSitemap(readFileSync(sitemapPath, 'utf8'), changedPages(base), iso)
  writeFileSync(sitemapPath, xml)
  process.stdout.write(`docs/sitemap.xml: lastmod ${iso} on ${bumped} page(s) whose text differs from ${base}\n`)
}
