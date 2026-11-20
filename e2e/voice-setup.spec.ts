import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'

/**
 * The first visit to the Voice surface: what the setup downloads, the setup
 * itself with its phases, cancel and continue, a failed setup, an unsupported
 * machine, and repair and uninstall in the settings popup. The Rust side is
 * the mock (e2e/support/tauri-mock.ts), which walks the same phases and
 * returns the same fields as commands/voice_loop.rs.
 */

const SHOTS = process.env.LU_VOICE_SHOTS

async function boot(page: Page, voiceLoop: TauriMockOptions['voiceLoop'] = {}) {
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

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_VOICE_LOOP_CALLS__?: Array<{ cmd: string; force?: boolean }> }).__E2E_VOICE_LOOP_CALLS__ ?? [])

test('Voice is reached from the main navigation and first shows what the setup downloads', async ({ page }) => {
  await boot(page)
  const view = page.getByTestId('voice-view')
  await expect(view.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true })).toHaveAttribute('aria-current', 'page')

  // The totals are on the surface, the parts are one click away.
  const size = view.getByLabel('Setup size')
  await expect(size).toContainText('about 699.1 MB')
  await expect(size).toContainText('46.6 GB')
  await view.getByRole('button', { name: 'What is downloaded' }).click()
  const list = view.getByRole('list', { name: 'What the setup downloads' })
  await expect(list.getByRole('listitem')).toHaveCount(5)
  await expect(list).toContainText('Python 3.12.15')
  await expect(list).toContainText('Speech packages')
  await expect(list).toContainText('Whisper base.en (CTranslate2)')
  await expect(list).toContainText('140.9 MB')
  await expect(list).toContainText('Turns what you say into text.')

  const credits = view.getByLabel('Credits')
  await expect(credits).toContainText('Pocket TTS by Kyutai, licensed under CC BY 4.0.')
  await expect(credits).toContainText('Alba MacKenna')

  // The internal project name is somebody else's brand. It is never shown.
  await expect(page.locator('body')).not.toContainText(/astra/i)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-setup.png` })
})

test('Install walks the phases, shows what pip does in the package phase, and ends on the Start button', async ({ page }) => {
  await boot(page, { pollsPerPhase: 2 })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Install' }).click()

  const progress = view.getByTestId('voice-setup-progress')
  await expect(progress).toBeVisible()
  await expect(view.getByRole('button', { name: 'Install' })).toHaveCount(0)

  // Package phase: pip has no byte totals, so the line shows its own output
  // and the bar has no number.
  await expect(progress.locator('[aria-current="step"]')).toHaveText('Packages', { timeout: 20_000 })
  await expect(view.getByTestId('voice-setup-line')).toContainText('Downloading torch-2.14.1')
  await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-setup-packages.png` })

  // Model phase: bytes, speed and the file.
  await expect(progress.locator('[aria-current="step"]')).toHaveText('Models', { timeout: 20_000 })
  await expect(view.getByTestId('voice-setup-line')).toContainText('177.9 MB of 355.8 MB')
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')

  await expect(view.getByRole('button', { name: 'Start voice' })).toBeVisible({ timeout: 20_000 })
  await expect(view.getByTestId('voice-status')).toHaveText('Ready')
  expect((await calls(page)).filter((c) => c.cmd === 'voice_loop_install')).toEqual([{ cmd: 'voice_loop_install', force: false }])
})

test('a cancelled setup says what is kept and continues where it stopped', async ({ page }) => {
  await boot(page, { pollsPerPhase: 30 })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Install' }).click()
  await expect(view.getByTestId('voice-setup-progress')).toBeVisible()
  await view.getByRole('button', { name: 'Cancel' }).click()

  await expect(view.getByText('The setup was cancelled.')).toBeVisible()
  await expect(view.getByTestId('voice-setup-progress')).toHaveCount(0)
  await view.getByRole('button', { name: 'Continue setup' }).click()
  await expect(view.getByTestId('voice-setup-progress')).toBeVisible()
  expect((await calls(page)).map((c) => c.cmd)).toEqual(['voice_loop_install', 'voice_loop_install_cancel', 'voice_loop_install'])
})

test('a failed setup shows the reason and offers to try again', async ({ page }) => {
  await boot(page, { installError: 'Could not download the speech models: the connection was reset. Check your internet connection and try again.' })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Install' }).click()
  const alert = view.getByRole('alert')
  await expect(alert).toContainText('The setup did not finish.', { timeout: 20_000 })
  await expect(alert).toContainText('the connection was reset')
  await expect(view.getByRole('button', { name: 'Try again' })).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/03-setup-failed.png` })
})

test('an unsupported machine gets a calm sentence and no Install button', async ({ page }) => {
  await boot(page, { unsupportedReason: 'Voice needs a Mac with Apple silicon. This Mac has an Intel processor.' })
  const view = page.getByTestId('voice-view')
  await expect(view.getByRole('heading', { name: 'Voice is not available on this computer' })).toBeVisible()
  await expect(view.getByText('Voice needs a Mac with Apple silicon. This Mac has an Intel processor.')).toBeVisible()
  await expect(view.getByRole('button', { name: 'Install' })).toHaveCount(0)
  await expect(view.getByRole('alert')).toHaveCount(0)
})

test('settings are a popup with an X that Escape closes, with repair and uninstall inside', async ({ page }) => {
  await boot(page, { installed: true, pollsPerPhase: 30 })
  const view = page.getByTestId('voice-view')
  await expect(view.getByRole('button', { name: 'Start voice' })).toBeVisible()

  await view.getByRole('button', { name: 'Voice settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Voice settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Microphone' })).toHaveValue('')
  await expect(dialog.getByRole('switch', { name: 'Start with the microphone muted' })).toHaveAttribute('aria-checked', 'false')
  // The start sound is on until it is switched off, and the choice is kept.
  const startSound = dialog.getByRole('switch', { name: 'Play a short sound when a session starts listening' })
  await expect(startSound).toHaveAttribute('aria-checked', 'true')
  await startSound.click()
  await expect(startSound).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('locally-uncensored-voice') ?? '{}').state?.loopStartSound)).toBe(false)
  await startSound.click()
  if (SHOTS) {
    // The popup fades in.
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/04-settings.png` })
  }

  // The X sits in the top right corner of the popup.
  const close = dialog.getByRole('button', { name: 'Close' })
  const [panel, x] = await Promise.all([dialog.boundingBox(), close.boundingBox()])
  expect(x!.x + x!.width / 2).toBeGreaterThan(panel!.x + panel!.width * 0.8)
  expect(x!.y + x!.height / 2).toBeLessThan(panel!.y + 80)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // The mute default is remembered.
  await view.getByRole('button', { name: 'Voice settings' }).click()
  await dialog.getByRole('switch', { name: 'Start with the microphone muted' }).click()
  await expect(dialog.getByRole('switch', { name: 'Start with the microphone muted' })).toHaveAttribute('aria-checked', 'true')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('locally-uncensored-voice') ?? '{}').state)
  expect(stored.loopStartMuted).toBe(true)
  expect(Object.keys(stored).filter((key) => /token|secret|apikey/i.test(key))).toEqual([])

  // Uninstall asks first. Keep leaves everything alone.
  await dialog.getByRole('button', { name: 'Uninstall' }).click()
  await expect(dialog.getByText('Remove the voice engine, its packages and its speech models')).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep' }).click()
  expect((await calls(page)).map((c) => c.cmd)).not.toContain('voice_loop_uninstall')

  // Repair runs the setup again with force and shows it.
  await dialog.getByRole('button', { name: 'Repair' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(view.getByTestId('voice-setup-progress')).toBeVisible()
  expect((await calls(page)).filter((c) => c.cmd === 'voice_loop_install')).toEqual([{ cmd: 'voice_loop_install', force: true }])
})

test('Uninstall removes the engine and the surface is back at the setup', async ({ page }) => {
  await boot(page, { installed: true, uninstallMs: 1500 })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Voice settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Voice settings' })
  // What Repair does, in the words of what it does.
  await expect(dialog).toContainText('Repair checks the packages and every model file, and downloads again only what is missing or does not match.')
  await dialog.getByRole('button', { name: 'Uninstall' }).click()
  await dialog.getByRole('button', { name: 'Remove' }).click()
  // While the files are being deleted the surface says so and offers no Start.
  await expect(view.getByTestId('voice-removing')).toHaveText('Removing the voice engine')
  await expect(view.getByRole('button', { name: 'Start voice' })).toHaveCount(0)
  await expect(view.getByRole('button', { name: 'Install' })).toHaveCount(0)
  await expect(view.getByRole('button', { name: 'Install' })).toBeVisible()
  expect((await calls(page)).map((c) => c.cmd)).toContain('voice_loop_uninstall')
})

test('nothing is cut off in a small window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME, platform: 'mac' as const, voiceLoop: {} })
  await seedOnboardingDone(page)
  await page.goto('/')
  // Below 1024 px the navigation folds into its menu.
  await page.getByRole('button', { name: 'Main navigation' }).click()
  await page.getByRole('menuitem', { name: 'Voice' }).click()
  const view = page.getByTestId('voice-view')
  await expect(view.getByRole('button', { name: 'Install' })).toBeVisible()
  // The page itself never scrolls sideways, and the Install button is reachable.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await view.getByRole('button', { name: 'Install' }).scrollIntoViewIfNeeded()
  const box = await view.getByRole('button', { name: 'Install' }).boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(900)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/05-setup-900x600.png` })
})
