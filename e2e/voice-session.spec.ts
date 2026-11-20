import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, type AppWindow } from './support/ui'

/**
 * The session part of the Voice surface without a voice loop behind it: what
 * the user sees when the microphone is blocked, when the voice engine does
 * not answer, and whether a running session with an approval fits a small
 * window. The full talk against the real voice loop is
 * voice-session-live.spec.ts.
 */

const SHOTS = process.env.LU_VOICE_SHOTS

async function boot(page: Page, opts: { micError?: string; micNeverAnswers?: boolean; width?: number; wholeComputerUnanswered?: boolean } = {}) {
  if (opts.width) await page.setViewportSize({ width: opts.width, height: 600 })
  await page.addInitScript(([micError, never]: [string | null, boolean]) => {
    MediaDevices.prototype.getUserMedia = async () => {
      // The permission prompt of the system is up and nobody answers it.
      if (never) return new Promise<MediaStream>(() => {})
      if (micError) throw new DOMException('refused', micError)
      // A silent microphone.
      return new AudioContext().createMediaStreamDestination().stream
    }
  }, [opts.micError ?? null, opts.micNeverAnswers === true] as [string | null, boolean])
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac' as const,
    // Port 9 answers nobody: the voice engine is "started" and silent.
    voiceLoop: { installed: true, session: { port: 9, token: 'e2e-launch-token'.padEnd(64, '0') }, wholeComputerUnanswered: opts.wholeComputerUnanswered },
  })
  await seedOnboardingDone(page)
  if (opts.wholeComputerUnanswered) {
    // "Where it may work" stands on "Whole computer" from an earlier run of the app.
    await page.addInitScript(() => {
      localStorage.setItem('locally-uncensored-voice', JSON.stringify({ state: { loopAgent: true, loopScope: 'computer', loopComputerConfirmed: true }, version: 0 }))
    })
  }
  await page.goto('/')
  if (opts.width && opts.width < 1024) {
    await page.getByRole('button', { name: 'Main navigation' }).click()
    await page.getByRole('menuitem', { name: 'Voice' }).click()
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  }
  await expect(page.getByTestId('voice-view')).toBeVisible()
}

test('a blocked microphone is explained in plain words, with the way to fix it', async ({ page }) => {
  await boot(page, { micError: 'NotAllowedError' })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'error')
  const alert = view.getByRole('alert')
  await expect(alert).toContainText('LU is not allowed to use the microphone.')
  await expect(alert).toContainText('Open System Settings, Privacy & Security, Microphone, and switch it on for LU.')
  await expect(view.getByRole('button', { name: 'Start again' })).toBeVisible()
  // The voice engine was never started for a session that cannot hear.
  const started = await page.evaluate(() => ((window as unknown as { __E2E_VOICE_LOOP_CALLS__?: Array<{ cmd: string }> }).__E2E_VOICE_LOOP_CALLS__ ?? []).filter((c) => c.cmd === 'voice_loop_start'))
  expect(started).toHaveLength(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/06-microphone-blocked.png` })
})

test('no microphone at all says so', async ({ page }) => {
  await boot(page, { micError: 'NotFoundError' })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByRole('alert')).toContainText('No microphone was found. Connect one and start again.')
})

test('a voice engine that does not answer ends in a readable error, and the launch token stays out of the page', async ({ page }) => {
  await boot(page)
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'error', { timeout: 30_000 })
  await expect(view.getByRole('alert')).toContainText('The voice engine did not answer.')
  await expect(view.getByRole('alert')).not.toContainText('Failed to fetch')
  await expect(page.locator('body')).not.toContainText('e2e-launch-token')
  const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(persisted).not.toContain('e2e-launch-token')
  // Starting again is one click.
  await expect(view.getByRole('button', { name: 'Start again' })).toBeVisible()
})

test('a start that waits for the answer to "Whole computer" says so, instead of a chat model that never gets ready', async ({ page }) => {
  // Windows run A22: three minutes of "Getting the chat model ready" behind a window of the system.
  await boot(page, { wholeComputerUnanswered: true })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-status')).toContainText('Waiting for your answer in the system window "Let Voice work on the whole computer?"')
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'starting')
  await expect(view.getByTestId('voice-status')).not.toContainText('Getting the chat model ready')
  const asked = await page.evaluate(() => ((window as unknown as { __E2E_VOICE_LOOP_CALLS__?: Array<{ cmd: string; on?: boolean }> }).__E2E_VOICE_LOOP_CALLS__ ?? []).filter((c) => c.cmd === 'fs_whole_computer' && c.on === true))
  expect(asked).toHaveLength(1)
  // Stop still ends a start that waits.
  await view.getByRole('button', { name: 'Stop voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle')
})

test('a session that ends because the user left Voice says so when they come back', async ({ page }) => {
  await boot(page, { micNeverAnswers: true })
  const view = page.getByTestId('voice-view')
  await view.getByRole('button', { name: 'Start voice' }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'starting')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toHaveCount(0)
  await nav.getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(view.getByTestId('voice-session')).toHaveAttribute('data-phase', 'idle')
  await expect(view.getByTestId('voice-status')).toHaveText('The session ended when you left Voice. Start again to continue.')
  await expect(view.getByRole('button', { name: 'Start again' })).toBeVisible()
  // The next start clears the sentence.
  await view.getByRole('button', { name: 'Start again' }).click()
  await expect(view.getByTestId('voice-status')).not.toContainText('The session ended')
})

test('a running session with an approval fits a 900 by 600 window', async ({ page }) => {
  await boot(page, { width: 900 })
  const view = page.getByTestId('voice-view')
  await expect(view.getByRole('button', { name: 'Start voice' })).toBeVisible()
  // The state of a session in the middle of a tool call, without the engine.
  await appModules(page, ['/src/stores/voiceSessionStore.ts'])
  await page.evaluate(() => {
    const { useVoiceSessionStore } = (window as unknown as AppWindow).__APP__['/src/stores/voiceSessionStore.ts']
    const send = useVoiceSessionStore.getState().dispatch
    send({ type: 'start', at: Date.now(), muted: false })
    send({ type: 'brain', modelLabel: 'Qwen3.5 9B', notice: null })
    send({ type: 'ready' })
    send({ type: 'user-text', text: 'What is on my shopping list?', final: true })
    send({ type: 'bot-text', text: 'Milk, bread and two lemons. Shall I add anything?' })
    send({ type: 'latency', ms: 1900 })
    send({ type: 'user-text', text: 'Add coffee and save it as a file.', final: true })
    send({ type: 'tool-waiting', id: 'call-1', name: 'file_write', args: { path: 'shopping.txt', content: 'milk\nbread\nlemons\ncoffee' } })
  })
  await expect(view.getByTestId('voice-status')).toHaveText('Waiting for your approval')
  // The approval strip of the chat, and the waiting call as the chat's open tool block.
  const strip = view.getByTestId('voice-approval')
  await expect(strip.getByTestId('approval-what')).toHaveText('Voice wants to change a file. Nothing happens until you answer.')
  await expect(view.locator('[data-tool="file_write"]')).toHaveAttribute('data-status', 'pending_approval')
  for (const button of [
    strip.getByRole('button', { name: 'Approve', exact: true }),
    strip.getByRole('button', { name: 'Reject', exact: true }),
    view.getByRole('button', { name: 'Mute microphone', exact: true }),
    view.getByRole('button', { name: 'Stop voice', exact: true }),
  ]) {
    await expect(button).toBeVisible()
    const box = (await button.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(900)
    expect(box.y + box.height).toBeLessThanOrEqual(600)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/13-session-approval-900x600.png` })
})
