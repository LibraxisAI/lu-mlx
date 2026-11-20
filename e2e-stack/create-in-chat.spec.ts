import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from '../e2e/support/tauri-mock'
import { seedOnboardingDone, cloudSwitch } from '../e2e/support/cloud-mock'

/**
 * Create in chat, the desktop UI against the local web stack. Nothing is
 * intercepted: the account release, the model list, the chat proxy with its
 * gate, the job routes with theirs, the credit booking in PostgreSQL, the
 * render worker and the preflight of every cross-origin call are the real
 * server. The Tauri shell is the mock of the e2e suite, the model is a local
 * 9B one, and the render provider is the stack's stand-in.
 *
 * Run: node scripts/create-chat-stack-probe.mjs <web repo>
 */
/** The web server of the stack, as this process reaches it. */
const WEB = process.env.LU_STACK_WEB ?? ''
/** The same server under the name the app knows it by (playwright.stack.config.ts). */
const CLOUD = process.env.LU_STACK_CLOUD ?? ''
const PROOF = process.env.LU_CREATE_CHAT_PROOF
type Account = { email: string; password: string }
const RELEASED = JSON.parse(process.env.LU_STACK_RELEASED ?? '{}') as Account
const UNRELEASED = JSON.parse(process.env.LU_STACK_UNRELEASED ?? '{}') as Account
/** The catalogue of the stack: one model that gets Create in chat, one that does not. */
const FIT = /Mistral Small 3\.2 24B/
const UNFIT = /Qwen 3\.5 9B/

interface Wire {
  token: string
  writes: Array<{ path: string; origin: string | null; status: number }>
  outside: string[]
}

async function boot(page: Page, account: Account): Promise<Wire> {
  const wire: Wire = { token: '', writes: [], outside: [] }
  page.on('response', async (res) => {
    const req = res.request()
    const url = new URL(req.url())
    if (url.pathname.endsWith('/auth/v1/token') && res.ok()) {
      wire.token = ((await res.json().catch(() => ({}))) as { access_token?: string }).access_token ?? wire.token
    }
    if (!req.url().startsWith(CLOUD)) return
    if (req.method() === 'POST' && url.pathname.startsWith('/api/jobs')) {
      wire.writes.push({ path: url.pathname, origin: await req.headerValue('x-lu-origin'), status: res.status() })
    }
  })
  page.on('requestfailed', (req) => {
    const host = new URL(req.url()).hostname
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== new URL(CLOUD).hostname && !host.endsWith('.supabase.co')) wire.outside.push(req.url())
  })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await page.goto('/')
  await cloudSwitch(page).click()
  await page.getByRole('button', { name: /Already subscribed\? Sign in/i }).click()
  await page.getByPlaceholder('Email').fill(account.email)
  await page.getByPlaceholder('Password').fill(account.password)
  await page.getByRole('button', { name: /^Sign in$/i }).click()
  await expect(cloudSwitch(page)).toBeChecked({ timeout: 30_000 })
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  return wire
}

async function pick(page: Page, model: RegExp) {
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()
  await page.getByRole('button', { name: model }).first().click()
}

const plugins = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Plugins' }).first()
const createSwitch = (page: Page) => page.getByTestId('plugins-create-switch')

/** With the menu open: switches Create on and waits until it has stayed on. */
async function switchCreateOn(page: Page) {
  await expect(createSwitch(page)).toBeEnabled()
  await expect(async () => {
    if ((await createSwitch(page).getAttribute('aria-pressed')) !== 'true') await createSwitch(page).click()
    await expect(createSwitch(page)).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(createSwitch(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('plugins-dot-create')).toBeVisible()
  await page.keyboard.press('Escape')
}

async function shot(page: Page, name: string) {
  if (!PROOF) return
  mkdirSync(PROOF, { recursive: true })
  await page.screenshot({ path: `${PROOF}/stack-${name}.png` })
}

async function ask(page: Page, text: string) {
  const composer = page.locator('textarea').first()
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await composer.fill(text)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 300_000 })
  await page.waitForTimeout(800)
  await composer.press('Enter')
}

/** The server's own answer, with the session of the signed-in account. */
async function api(wire: Wire, path: string, init: RequestInit = {}) {
  const res = await fetch(`${WEB}${path}`, { ...init, headers: { authorization: `Bearer ${wire.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}
const creditsLeft = async (wire: Wire) => Number(((await api(wire, '/api/jobs/quota')).body.remaining as { credits?: number } | undefined)?.credits)

/** Asks until the model has laid an order out. A 9B model does not call the
 *  tool on every try; three tries, each one a plain request a customer could type. */
async function orderFromTheModel(page: Page) {
  const card = page.getByTestId('create-order').last()
  const asks = [
    'Please create one image for me: a red fox in the snow. Lay out the order now.',
    'Use create_order now with one item: intent image, prompt "a red fox in the snow".',
    'Call the create_order tool: {"items":[{"intent":"image","prompt":"a red fox in the snow"}]}',
  ]
  for (const text of asks) {
    await ask(page, text)
    const got = await card.getByRole('button', { name: /^Start/ }).waitFor({ timeout: 240_000 }).then(() => true, () => false)
    if (got) return card
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 300_000 })
  }
  throw new Error('the local model never laid an order out in three tries')
}

test('a released account: the server releases, the model orders, approval books, the worker renders', async ({ page }) => {
  const wire = await boot(page, RELEASED)
  const me = await api(wire, '/api/me')
  expect((me.body.features as { createChat?: boolean } | undefined)?.createChat).toBe(true)

  // A model the catalogue does not release: greyed, with the reason.
  await pick(page, UNFIT)
  await plugins(page).click()
  await expect(createSwitch(page)).toBeVisible()
  await expect(createSwitch(page)).toBeDisabled()
  await expect(page.getByTestId('plugins-create-reason')).toHaveText('Not available with this model.')
  await shot(page, 'switch-greyed')
  await page.keyboard.press('Escape')

  // A model it releases: the switch is free.
  await pick(page, FIT)
  await plugins(page).click()
  await switchCreateOn(page)

  const before = await creditsLeft(wire)
  const card = await orderFromTheModel(page)
  await expect(card).toContainText(/credits/i)
  // Laid out, nothing booked: no job call yet, the balance has not moved by a render.
  expect(wire.writes.filter((w) => w.path === '/api/jobs')).toEqual([])
  await shot(page, 'order-awaiting')

  await card.getByRole('button', { name: /^Start/ }).click()
  await expect(card).toContainText('Done', { timeout: 300_000 })
  await expect(card.locator('img').first()).toBeVisible({ timeout: 60_000 })
  // The picture itself arrived, from the storage of the stack.
  expect(await card.locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(8)
  await shot(page, 'order-done')

  // Every booking call named the chat, and the real preflight let the header through.
  const submits = wire.writes.filter((w) => w.path === '/api/jobs')
  expect(submits).toHaveLength(1)
  expect(submits[0].origin).toBe('create-chat')
  expect(submits[0].status).toBeLessThan(300)
  // The browser only sends that POST after a preflight that allows the
  // header (it does not show its preflights to a test). The same question,
  // asked of the server directly with the app's origin, for every route an
  // order writes to:
  for (const path of ['/api/jobs', '/api/jobs/upload', '/api/jobs/adopt', '/api/jobs/studio-quote']) {
    const res = await fetch(`${WEB}${path}`, {
      method: 'OPTIONS',
      headers: { origin: new URL(page.url()).origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-lu-origin' },
    })
    expect(res.status, path).toBe(204)
    expect(res.headers.get('access-control-allow-headers') ?? '', path).toContain('x-lu-origin')
  }

  // The server booked what the card says was used.
  const used = Number((await card.innerText()).replace(/,/g, '').match(/Used\s+(\d+)/)?.[1])
  expect(used).toBeGreaterThan(0)
  await expect.poll(async () => before - (await creditsLeft(wire)), { timeout: 60_000 }).toBeGreaterThanOrEqual(used)

  // And it is in the gallery of the Create tab.
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.getByRole('button', { name: 'Open the gallery' }).click()
  await expect(page.locator('aside').filter({ hasText: 'Gallery' }).locator('.group').first()).toBeVisible({ timeout: 30_000 })
  expect(wire.outside).toEqual([])
})

test('a released account: "yes" approves, and "Not now" books nothing', async ({ page }) => {
  const wire = await boot(page, RELEASED)
  await pick(page, FIT)
  await plugins(page).click()
  await switchCreateOn(page)

  const first = await orderFromTheModel(page)
  const before = await creditsLeft(wire)
  await first.getByRole('button', { name: 'Not now' }).click()
  await expect(first).toContainText('Not started')
  expect(wire.writes.filter((w) => w.path === '/api/jobs')).toEqual([])

  const second = await orderFromTheModel(page)
  await ask(page, 'yes')
  await expect(second).toContainText('Done', { timeout: 300_000 })
  expect(wire.writes.filter((w) => w.path === '/api/jobs')).toHaveLength(1)
  expect(before - (await creditsLeft(wire))).toBeGreaterThan(0)
})

test('an account that is not released: no switch, and the server refuses the chat\'s job call', async ({ page }) => {
  const wire = await boot(page, UNRELEASED)
  const me = await api(wire, '/api/me')
  expect((me.body.features as { createChat?: boolean } | undefined)?.createChat).toBe(false)

  await pick(page, FIT)
  await plugins(page).click()
  await expect(page.getByText('Chat Tools').first()).toBeVisible()
  await expect(createSwitch(page)).toHaveCount(0)
  await shot(page, 'unreleased-plugins')
  await page.keyboard.press('Escape')

  // A plain message goes out as it always did: no Create tool, no word of it.
  const sent: string[] = []
  page.on('request', (req) => { if (req.url().includes('/chat/completions') && req.method() === 'POST') sent.push(req.postData() ?? '') })
  await ask(page, 'Say hello in one short sentence.')
  await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(0)
  expect(sent.join('\n')).not.toMatch(/create_order|create_options|Create switch/)

  // What a rebuilt client could send: the server says no, and nothing is booked.
  const before = await creditsLeft(wire)
  const refused = await api(wire, '/api/jobs', {
    method: 'POST',
    headers: { 'x-lu-origin': 'create-chat' },
    body: JSON.stringify({ kind: 'image', model: 'z-image-turbo', prompt: 'a red fox', params: { op: 'generate' } }),
  })
  expect(refused.status).toBe(403)
  expect(await creditsLeft(wire)).toBe(before)
})
