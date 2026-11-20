import { test, expect, type Page, type Route } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * More than one voice (the owner, roadmap for live speech): the voice is chosen
 * in the setup before anything is downloaded and in the voice settings
 * afterwards, a voice can be heard there, and a session asks the engine for
 * the chosen one. Rust is the mock, the voice engine is this spec answering
 * on the mock's port.
 *
 * Run: CI=1 LU_E2E_PORT=5273 npx playwright test e2e/voice-choice.spec.ts
 * Pictures: LU_A15_SHOTS=<folder>
 */

const SHOTS = process.env.LU_A15_SHOTS
const ENGINE = 'http://127.0.0.1:47720'
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' }

/** A third of a second of silence, mono 16 bit at 24 kHz, as the engine would send it. */
function silentWav(seconds = 0.35): Buffer {
  const samples = Math.round(24000 * seconds)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24)
  wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  return wav
}

async function boot(page: Page, voiceLoop: TauriMockOptions['voiceLoop'] = {}) {
  await page.addInitScript(() => {
    // A silent microphone, so a session can start.
    MediaDevices.prototype.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
  })
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac' as const,
    voiceLoop,
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()
}

type Call = { cmd: string; voice?: string }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_VOICE_LOOP_CALLS__?: Call[] }).__E2E_VOICE_LOOP_CALLS__ ?? [])
const chosen = async (page: Page) => (await calls(page)).filter((c) => c.cmd === 'voice_loop_set_voice').map((c) => c.voice)

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('the setup offers the voices before anything is downloaded, and counts the chosen one', async ({ page }) => {
  await boot(page)
  const view = page.getByTestId('voice-view')
  const picker = view.getByRole('combobox', { name: 'Voice' })
  await expect(picker).toHaveValue('alba')
  await expect(picker.locator('option')).toHaveText(['Alba', 'Anna', 'Marius'])
  await expect(view.getByLabel('Setup size')).toContainText('about 699.1 MB')
  await shot(page, '10-setup-voice-alba')

  await picker.selectOption('anna')
  await expect(picker).toHaveValue('anna')
  expect(await chosen(page)).toEqual(['anna'])
  // Anna's file is a little larger than Alba's, and the total follows.
  await expect(view.getByLabel('Setup size')).toContainText('about 700.7 MB')

  await view.getByRole('button', { name: 'What is downloaded' }).click()
  const list = view.getByRole('list', { name: 'What the setup downloads' })
  // Still five parts: of the voices only the chosen one is fetched.
  await expect(list.getByRole('listitem')).toHaveCount(5)
  await expect(list).toContainText('anna')
  await expect(list).not.toContainText('alba')
  const credits = view.getByLabel('Credits')
  await expect(credits).toContainText('Voice "anna" from the CSTR VCTK Corpus')
  await expect(credits).not.toContainText('Alba MacKenna')
  await shot(page, '11-setup-voice-anna')

  await view.getByRole('button', { name: 'Install' }).click()
  await expect(view.getByRole('button', { name: 'Start voice' })).toBeVisible({ timeout: 30_000 })
  // Nothing was installed before the user said Install.
  const order = (await calls(page)).map((c) => c.cmd)
  expect(order.indexOf('voice_loop_set_voice')).toBeLessThan(order.indexOf('voice_loop_install'))
  await expect(page.locator('body')).not.toContainText(/astra/i)
})

test('in the settings a voice is picked, fetched alone, and heard', async ({ page }) => {
  const asked: Array<{ voice?: string; auth: string | null }> = []
  await page.route(`${ENGINE}/sample`, async (route: Route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    asked.push({ voice: request.postDataJSON()?.voice, auth: await request.headerValue('authorization') })
    await route.fulfill({ status: 200, contentType: 'audio/wav', headers: CORS, body: silentWav() })
  })
  await boot(page, { installed: true, voiceDownloadMs: 1500 })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Voice settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Voice settings' })
  const picker = dialog.getByRole('combobox', { name: 'Voice', exact: true })
  const line = dialog.getByTestId('voice-voice-line')
  await expect(picker).toHaveValue('alba')
  await expect(line).toContainText('A new voice speaks from the next session on.')
  await shot(page, '12-settings-voice')

  // A voice that is not on this computer: fetched now, the rest stays as it is.
  await picker.selectOption('marius')
  await expect(line).toHaveText('Getting Marius ready.')
  await expect(picker).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Listen' })).toBeDisabled()
  await expect(picker).toBeEnabled({ timeout: 10_000 })
  await expect(picker).toHaveValue('marius')
  await expect(dialog.getByLabel('Credits')).toContainText('Voice "marius" from the Unmute Voice Donation Project')
  const made = (await calls(page)).map((c) => c.cmd)
  expect(made).toContain('voice_loop_set_voice')
  expect(made).not.toContain('voice_loop_install')
  expect(made).not.toContain('voice_loop_uninstall')

  // Hear it. The engine is started for that and asked for exactly this voice.
  await dialog.getByRole('button', { name: 'Listen' }).click()
  await expect(dialog.getByRole('button', { name: 'Listen' })).toBeVisible({ timeout: 10_000 })
  expect(asked).toHaveLength(1)
  expect(asked[0].voice).toBe('marius')
  expect(asked[0].auth).toMatch(/^Bearer \S{20,}$/)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  expect((await calls(page)).map((c) => c.cmd)).toContain('voice_loop_start')
  await shot(page, '13-settings-voice-marius')

  // Escape closes the popup, as before.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('a voice the engine cannot play says so in a sentence', async ({ page }) => {
  await page.route(`${ENGINE}/sample`, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    await route.fulfill({ status: 409, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'A voice session is running. Stop it to listen to a voice.' }) })
  })
  await boot(page, { installed: true })
  await page.getByTestId('voice-view').getByRole('button', { name: 'Voice settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Voice settings' })
  await dialog.getByRole('button', { name: 'Listen' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('A voice session is running. Stop it to listen to a voice.')
  await expect(dialog.getByRole('button', { name: 'Listen' })).toBeEnabled()
})

test('a session asks the engine for the chosen voice', async ({ page }) => {
  const sessions: Array<{ voice?: string }> = []
  await page.route(`${ENGINE}/session`, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    sessions.push({ voice: route.request().postDataJSON()?.voice })
    // The engine of this spec only listens to what it is asked.
    await route.fulfill({ status: 503, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'The voice loop is shutting down.' }) })
  })
  await boot(page, { installed: true })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Voice settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Voice settings' })
  await dialog.getByRole('combobox', { name: 'Voice', exact: true }).selectOption('anna')
  await expect(dialog.getByRole('combobox', { name: 'Voice', exact: true })).toHaveValue('anna')
  await page.keyboard.press('Escape')

  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect.poll(() => sessions.length, { timeout: 30_000 }).toBe(1)
  expect(sessions[0].voice).toBe('anna')
})

test('the voice choice fits a small window, in the setup and in the settings', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' as const, voiceLoop: {} })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Main navigation' }).click()
  await page.getByRole('menuitem', { name: 'Voice' }).click()
  const view = page.getByTestId('voice-view')
  const picker = view.getByRole('combobox', { name: 'Voice' })
  await expect(picker).toBeVisible()
  await view.getByRole('button', { name: 'Install' }).scrollIntoViewIfNeeded()
  await expect(view.getByRole('button', { name: 'Install' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

  await view.getByRole('button', { name: 'Voice settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Voice settings' })
  const [panel, inside] = await Promise.all([dialog.boundingBox(), dialog.getByRole('combobox', { name: 'Voice', exact: true }).boundingBox()])
  expect(panel!.x).toBeGreaterThanOrEqual(0)
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(900)
  expect(inside!.x).toBeGreaterThanOrEqual(panel!.x)
  expect(inside!.x + inside!.width).toBeLessThanOrEqual(panel!.x + panel!.width)
  await shot(page, '14-settings-voice-900x600')
})
