// @vitest-environment jsdom
/**
 * Die Preisseite auf locallyuncensored.com.
 *
 * Die Zahlen selbst haelt scripts/check-cloud-sales.mjs gegen das Web-Repo,
 * weil nur dort die Quelle liegt. Das Skript braucht aber einen Pfad auf ein
 * ausgechecktes Web-Repo und laeuft deshalb NICHT in `npm test`. Ein Preis
 * konnte hier also still veralten, bis jemand den Release-Waechter von Hand
 * anwarf; genau das ist am 10.09.2026 passiert, als die Packs neu bepreist
 * wurden und diese Seite die alten Zahlen weiter nannte. Am 13.09.2026 ist dieselbe Leiter ein zweites Mal
 * neu gesetzt worden, diesmal auf fuenf Stufen mit neuen Ids; die alten drei
 * sind stillgelegt und werden nicht mehr verkauft. Darum stehen die acht
 * Betraege unten als Literale, die bei jedem Testlauf anschlagen.
 *
 * Sonst steht hier, was die Seite SAGEN muss und was sie nicht sagen darf:
 * sie nimmt kein Geld an, sie verspricht nichts, was hinter einem Schalter
 * liegt, ohne den Schalter zu nennen, und sie nennt die beiden Grenzen, die
 * keine Einstellung verschiebt.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const html = readFileSync('docs/pricing/index.html', 'utf8')
const page = new DOMParser().parseFromString(html, 'text/html')
const text = () => page.body.textContent ?? ''

// Der Waechter haengt seit 14.09.2026 am Ziel des Links, nicht an seiner
// Klasse: die neu veroeffentlichte Seite (97c2c730) nennt die Planknoepfe
// .cta und verlinkt die Packkarten ganz ohne Klasse. Ein Waechter, der eine
// Klasse verlangt, waere durch ein Umbenennen stillzulegen gewesen. Aus
// demselben Grund steht statt "gar kein Skript" jetzt eine Erlaubnisliste:
// das gemeinsame Seitenskript /assets/lu.js liegt auf jeder Seite von
// docs/, und das Angebot als ld+json ist Auszeichnung, kein Bezahlcode.
it('takes no money itself: every buy link goes to the checkout domain', () => {
  const links = [...page.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .map((a) => new URL(a.getAttribute('href')!, 'https://locallyuncensored.com'))
  const buys = links.filter((url) => url.hostname === 'lu-labs.ai')
  expect(buys.length).toBeGreaterThanOrEqual(2)
  for (const url of buys) expect(url.searchParams.get('src')).toBe('luc-pricing')
  for (const url of links) expect(url.hostname).not.toMatch(/stripe|paypal|checkout/i)
  expect(page.querySelectorAll('form')).toHaveLength(0)
  for (const tag of page.querySelectorAll('script')) {
    const src = tag.getAttribute('src')
    if (src === null) expect(tag.getAttribute('type')).toBe('application/ld+json')
    else expect(src).toBe('/assets/lu.js')
  }
})

it('names the switch in the same breath as the capability behind it', () => {
  // Der Auftrag ist ausdruecklich: was hinter dem Schalter liegt, wird im
  // selben Satz als hinter dem Schalter liegend benannt. Sonst liest der
  // Kaeufer eine Zusage und findet eine Ablehnung.
  expect(text()).toMatch(/once you turn your own filter off/i)
  // Entscheid David vom 13.09.2026: der Bestaetigungsschritt faellt fuer 3.0.0
  // weg und kommt in 3.0.1 wieder. Solange er nicht kommt, darf die Seite ihn
  // auch nicht ankuendigen; was hinter dem Schalter liegt, steht weiter da.
  expect(text()).not.toMatch(/18 or older|age confirmation/i)
})

// Entscheid David vom 12.09.2026 zum Zusatzfund V3: ein einmaliger Pack
// oeffnet die Freimenge nicht auf Dauer. Die Bedingung heisst seitdem
// "laufendes bezahltes Abo" und nicht mehr "hat je gezahlt", also darf die
// alte Formulierung hier auch nicht mehr verlangt werden.
it('says that unmetered needs an active plan, not a euro once', () => {
  expect(text()).toMatch(/needs an active paid plan/i)
  expect(text()).toMatch(/accounts without an active plan keep paying credits/i)
  expect(text()).not.toMatch(/never paid/i)
  expect(text()).toMatch(/no free tier/i)
  expect(text()).toMatch(/API keys always pay credits/i)
})

it('states the two lines no setting moves', () => {
  expect(text()).toContain('Material involving minors')
  expect(text()).toContain('without their consent')
})

it('does not sell cloud as private', () => {
  expect(text()).toMatch(/not local privacy/i)
  expect(text()).not.toMatch(/we never see|fully private|zero knowledge/i)
})

it('is discoverable, canonical and free of dashes', () => {
  expect(page.documentElement.lang).toBe('en')
  expect(page.querySelectorAll('h1')).toHaveLength(1)
  expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href'))
    .toBe('https://locallyuncensored.com/pricing/')
  expect(readFileSync('docs/index.html', 'utf8')).toContain('href="/pricing/"')
  expect(readFileSync('docs/sitemap.xml', 'utf8')).toContain('<loc>https://locallyuncensored.com/pricing/</loc>')
  expect(html).not.toMatch(/[–—]/u)
})

// Quelle der Wahrheit im Web-Repo, nicht hier: die Packs stehen in
// `apps/web/lib/billing/topup.ts` (TOPUP_PACKS), die Monatsguthaben in
// `apps/web/lib/billing/credits.ts` (TIER_CREDITS), die Preise in
// `apps/web/lib/pricing.ts`. Wer dort eine Zahl aendert, aendert sie hier
// mit, und scripts/check-cloud-sales.mjs beweist vor dem Release, dass beide
// Seiten dieselbe nennen. Diese Literale sind die Reissleine dazwischen.
const PACKS = [
  { id: 'pack-15', eurCents: 1500, credits: 450_000 },
  { id: 'pack-35', eurCents: 3500, credits: 1_100_000 },
  { id: 'pack-75', eurCents: 7500, credits: 2_400_000 },
  { id: 'pack-125', eurCents: 12_500, credits: 4_050_000 },
  { id: 'pack-300', eurCents: 30_000, credits: 9_750_000 },
] as const

const PLANS = [
  { id: 'hosted', monthlyEUR: 19, annualEUR: 190, credits: 900_000 },
  { id: 'hosted-pro', monthlyEUR: 49, annualEUR: 490, credits: 2_350_000 },
  { id: 'hosted-max', monthlyEUR: 99, annualEUR: 990, credits: 5_000_000 },
] as const

// Die Karte traegt beide Zahlen seit 14.09.2026 in zwei Elementen statt in
// einem Satz. Gehalten wird, was der Kaeufer liest: beide Zahlen stehen
// sichtbar auf derselben Karte. Die Reihenfolge ist Gestaltung.
it('names the five credit packs the web repo actually sells', () => {
  const cards = [...page.querySelectorAll<HTMLElement>('[data-pack-id]')]
  expect(cards).toHaveLength(PACKS.length)
  for (const pack of PACKS) {
    const card = cards.find((c) => c.dataset.packId === pack.id)
    expect(card, `pack missing from the page: ${pack.id}`).toBeTruthy()
    expect(Number(card!.dataset.eurCents)).toBe(pack.eurCents)
    expect(Number(card!.dataset.credits)).toBe(pack.credits)
    // Der Kaeufer liest den Text, nicht das Attribut. Beide muessen stimmen.
    const shown = card!.textContent ?? ''
    expect(shown, pack.id).toContain(`${pack.credits.toLocaleString('en-US')} credits`)
    expect(shown, pack.id).toContain(`\u20ac${pack.eurCents / 100}`)
  }
})

// Seit 14.09.2026 sitzen Monats-, Jahrespreis und Guthaben als Attribute an
// EINER Plankarte statt in drei Zellen einer Tabellenzeile. Gehalten wird
// dasselbe wie vorher: alle drei Zahlen stehen im Attribut und sichtbar im
// Text derselben Karte.
it('names the three monthly plans the web repo actually sells', () => {
  const cards = [...page.querySelectorAll<HTMLElement>('[data-plan-id]')]
  expect(cards).toHaveLength(PLANS.length)
  for (const plan of PLANS) {
    const card = cards.find((c) => c.dataset.planId === plan.id)
    expect(card, `plan missing from the page: ${plan.id}`).toBeTruthy()
    expect(Number(card!.dataset.monthlyEur)).toBe(plan.monthlyEUR)
    expect(Number(card!.dataset.annualEur)).toBe(plan.annualEUR)
    expect(Number(card!.dataset.planCredits)).toBe(plan.credits)
    const shown = card!.textContent ?? ''
    expect(shown, plan.id).toContain(`\u20ac${plan.monthlyEUR}`)
    expect(shown, plan.id).toContain(`\u20ac${plan.annualEUR}`)
    expect(shown, plan.id).toContain(`${plan.credits.toLocaleString('en-US')} credits`)
  }
})

it('never says how many tokens a euro or a pack buys', () => {
  // Davids Ansage vom 10.09.2026. Die Credit-Rate je Token darf bleiben, die
  // IST der Einkaufspreis. Verboten ist die Umrechnung von Geld in eine
  // Tokenmenge, weil sie in einem Schritt den Aufschlag verraet und ein
  // Versprechen gibt, das keine Rechnung je einloest. Das Tagesbudget der
  // Flash-Klasse ist keine solche Umrechnung: es haengt am Konto, nicht am
  // Preis, und steht deshalb ohne Geldwort im selben Satz.
  const money = /\bEUR\b|\beuro\b|\bpack\b|\bcredits?\b/i
  const tokenAmount = /\d[\d,.]*\s*(?:k|m|million|thousand)?\s+(?:\w+\s+){0,5}tokens?\b/i
  for (const sentence of text().split(/(?<=[.!?])\s+/)) {
    if (tokenAmount.test(sentence) && money.test(sentence)) {
      throw new Error(`Money converted into tokens: ${sentence.trim()}`)
    }
  }
})

// ── Waechter ueber ganz docs/, nicht nur ueber /pricing/ ──────────────
//
// docs/ IST locallyuncensored.com. Zwei Aussagen sind am 11.09.2026 aus dem
// Ordner entfernt worden, beide standen jahrelang oeffentlich da, und keine
// hatte einen Test hinter sich. Sie duerfen nicht zurueckkommen.

const SITE: readonly (readonly [string, string])[] = readdirSync('docs', {
  recursive: true, encoding: 'utf8',
})
  .filter((name) => name.endsWith('.html'))
  .map((name) => [`docs/${name}`, readFileSync(`docs/${name}`, 'utf8')] as const)

it('scans the whole site, not an empty list', () => {
  // Ohne diesen Satz waere jeder Waechter darunter gruen, sobald die Suche
  // nichts mehr findet.
  expect(SITE.length).toBeGreaterThan(50)
})

it('never promises a Mac build of the desktop app', () => {
  // In keinem der 19 GitHub-Releases lag je eine .dmg. Zwei alte
  // Release-Artikel schickten den Leser trotzdem fuer eine zur
  // Releases-Seite, und vier weitere Stellen zaehlten Mac in der
  // Plattformliste der App mit. Richtig ist: Windows und Linux, und auf dem
  // Mac laeuft das gehostete Studio im Browser.
  const banned = [
    '.dmg',
    'Windows, Linux and macOS',
    'Windows, Linux and Mac',
    'Windows, Linux und Mac',
    'Windows, Linux \u0438 Mac',
    'Windows/macOS/Linux',
    'macOS and Linux builds',
  ]
  for (const [path, html] of SITE) {
    for (const phrase of banned) {
      expect(html.includes(phrase), `${path} promises a Mac build: ${phrase}`).toBe(false)
    }
  }
})

it('points the two old release articles at the browser studio instead', () => {
  for (const name of ['locally-uncensored-v1-5-release', 'locally-uncensored-v2-2-2-release']) {
    const html = readFileSync(`docs/blog/${name}.html`, 'utf8')
    expect(html, name).toMatch(/no Mac (build|download)|never shipped a Mac build/i)
    expect(html, name).toContain('lu-labs.ai')
    // Dieselben zwei Dateien sind beim Umschreiben von 90 Gedankenstrichen
    // befreit worden.
    expect(html, name).not.toMatch(/[\u2013\u2014]|&[mn]dash;/u)
  }
})

it('never says how many tokens a euro or a pack buys, on any page', () => {
  // Davids Ansage vom 10.09.2026, hier fuer die ganze Seite. Erlaubt bleibt
  // die Rate: "0.085 credits per output token", "285,000 credits per million
  // tokens". Verboten ist die Menge neben dem Geld: "a 15 EUR pack is 450,000
  // tokens". Das Wort "per" im Treffer trennt die beiden Faelle, und der
  // Abstand von 60 Zeichen haelt Tabellenzellen auseinander, die ohne Punkt
  // aneinanderstossen.
  const MONEY = /\bEUR\b|\beuros?\b|\u20ac|&euro;|\bpacks?\b/gi
  const TOKENS = /\d[\d,.]*\s*(?:k|m|million|thousand)?\s+(?:\w+\s+){0,3}tokens?\b/gi
  for (const [path, html] of SITE) {
    const flat = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
    const money = [...flat.matchAll(MONEY)].map((m) => m.index)
    for (const hit of flat.matchAll(TOKENS)) {
      if (/\bper\b/i.test(hit[0])) continue
      const from = hit.index, to = from + hit[0].length
      // "1M token context" is a model's context window, not what money buys.
      if (/^\s*(?:context|window)\b/i.test(flat.slice(to, to + 12))) continue
      if (money.some((i) => i > from - 60 && i < to + 60)) {
        throw new Error(`${path} converts money into tokens: ${flat.slice(Math.max(0, from - 90), to + 60)}`)
      }
    }
  }
})

it('the cloud page and the pricing page state the same catalogue size', () => {
  // Beide Seiten nennen die Zahlen jetzt mit denselben Ankern. Gegen das
  // Web-Repo haelt sie scripts/check-cloud-sales.mjs; hier wird nur
  // bewiesen, dass die zwei Seiten einander nicht widersprechen.
  const cloud = new DOMParser().parseFromString(readFileSync('docs/cloud/index.html', 'utf8'), 'text/html')
  for (const anchor of ['catalogCount', 'measuredCount', 'unfilteredCount'] as const) {
    const attr = anchor.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    const here = page.querySelector<HTMLElement>(`[data-${attr}]`)
    const there = cloud.querySelector<HTMLElement>(`[data-${attr}]`)
    expect(here, `pricing page lost its ${attr}`).toBeTruthy()
    expect(there, `cloud page lost its ${attr}`).toBeTruthy()
    expect(there!.dataset[anchor]).toBe(here!.dataset[anchor])
    expect(there!.textContent).toBe(here!.dataset[anchor])
  }
})
