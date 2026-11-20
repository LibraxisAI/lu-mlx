import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, openNewChat, type AppWindow } from './support/ui'

/**
 * The microphone can be chosen in the settings, and dictation records from it.
 *
 * Chromium's fake capture devices stand in for real ones: a default input and
 * two named ones. They behave like a webview in the two points this is about.
 * Before the microphone was allowed the devices have no names, and a device id
 * that does not exist is refused with OverconstrainedError.
 *
 * Nobody can answer a permission prompt in a headless browser, so Chromium is
 * started with the flag that answers every prompt with yes. With that flag it
 * also names its devices from the start, which no webview does. The page
 * therefore gets the rule of the specification laid over the device list: no
 * names and no ids until a microphone was opened once, or from the start for
 * a test that plays an app that was allowed on an earlier day. A refusal is
 * played the same way. Opening a device, and refusing an id that does not
 * exist, is the browser's own doing.
 *
 * A screenshot of each state goes to LU_MIC_PROOF_DIR when that is set.
 */
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

const proofDir = process.env.LU_MIC_PROOF_DIR

async function proof(page: Page, name: string) {
  if (proofDir) await page.screenshot({ path: `${proofDir}/${name}.png` })
}

/** Every microphone the page opened: what it asked for and what it got. */
interface Opened { wanted: string | null; label: string }

/** How the user answers, or has answered, the question for the microphone. */
type Access = 'ask' | 'allowed' | 'refused'

async function boot(page: Page, access: Access = 'ask') {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await page.addInitScript((answer) => {
    const opened: { wanted: string | null; label: string }[] = []
    ;(window as unknown as { __MICS__: typeof opened }).__MICS__ = opened
    const devices = navigator.mediaDevices
    let named = answer === 'allowed'
    const open = devices.getUserMedia.bind(devices)
    devices.getUserMedia = async (constraints) => {
      if (answer === 'refused') throw new DOMException('Permission denied', 'NotAllowedError')
      const audio = constraints?.audio
      const wanted = typeof audio === 'object' ? (audio.deviceId as { exact?: string } | undefined)?.exact ?? null : null
      const stream = await open(constraints)
      named = true
      opened.push({ wanted, label: stream.getAudioTracks()[0]?.label ?? '' })
      return stream
    }
    const list = devices.enumerateDevices.bind(devices)
    devices.enumerateDevices = async () => {
      const all = await list()
      if (named) return all
      // One nameless entry per kind, as a webview lists them before access.
      const kinds = Array.from(new Set(all.map((d) => d.kind)))
      return kinds.map((kind) => ({ kind, deviceId: '', groupId: '', label: '', toJSON: () => ({}) }))
    }
  }, access)
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
}

const NAMES = ['System default', 'Fake Audio Input 1', 'Fake Audio Input 2']

/**
 * Ask for the microphone with the button of the settings. The
 * names can show up through the device-change event before the call itself
 * has returned, so this waits for the call too: what is opened later is then
 * counted from a settled state.
 */
async function allowMicrophone(page: Page) {
  await page.getByTestId('settings-microphone-allow').click()
  await expect.poll(() => optionTexts(page)).toEqual(NAMES)
  await expect.poll(async () => (await opened(page)).length).toBe(1)
}

async function openSpeechSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.getByRole('button', { name: 'Voice & Remote' }).click()
  await expect(page.getByTestId('settings-microphone')).toBeVisible()
  await page.getByTestId('settings-microphone').scrollIntoViewIfNeeded()
}

const VOICE_STORE = '/src/stores/voiceStore.ts'

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __MICS__: Opened[] }).__MICS__)
const optionTexts = (page: Page) => page.getByTestId('settings-microphone').locator('option').allTextContents()

/**
 * One take with the microphone button of the chat. Whether speech-to-text is
 * installed is not the subject here, so the button is switched on directly,
 * and what the transcription says afterwards is not looked at.
 */
async function dictateOnce(page: Page) {
  await appModules(page, [VOICE_STORE])
  await openNewChat(page)
  await page.evaluate((path) => {
    (window as unknown as AppWindow).__APP__[path].useVoiceStore.getState().setSttAvailable(true)
  }, VOICE_STORE)
  await page.getByRole('button', { name: 'Start voice input' }).click()
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible()
  // Recording, and nothing was reported on the way there.
  expect(await page.evaluate((path) => {
    const { isRecording, sttError } = (window as unknown as AppWindow).__APP__[path].useVoiceStore.getState()
    return { isRecording, sttError }
  }, VOICE_STORE)).toEqual({ isRecording: true, sttError: null })
  await page.getByRole('button', { name: 'Stop recording' }).click()
}

test('the microphone is chosen in the settings and dictation records from it', async ({ page }) => {
  await boot(page)
  await openSpeechSettings(page)

  // Before the microphone was allowed: the system default and nothing nameless.
  await expect(page.getByTestId('settings-microphone-allow')).toBeVisible()
  expect(await optionTexts(page)).toEqual(['System default'])
  await expect(page.getByTestId('settings-microphone-hint')).toContainText('listed by name once this app may use the microphone')
  await proof(page, '1-before-access')

  await allowMicrophone(page)
  await expect(page.getByTestId('settings-microphone-allow')).toHaveCount(0)

  await page.getByTestId('settings-microphone').selectOption({ label: 'Fake Audio Input 2' })
  await expect(page.getByTestId('settings-microphone-hint')).toHaveText('Used for dictation in chat and for Voice.')
  await proof(page, '2-microphone-chosen')
  const chosen = await page.getByTestId('settings-microphone').inputValue()
  expect(chosen).not.toBe('')

  const before = (await opened(page)).length
  await dictateOnce(page)
  const takes = (await opened(page)).slice(before)
  expect(takes).toEqual([{ wanted: chosen, label: 'Fake Audio Input 2' }])
})

test('an unplugged microphone stays chosen and dictation records from the system default', async ({ page }) => {
  // Allowed on an earlier day: the names are there without asking.
  await boot(page, 'allowed')
  await openSpeechSettings(page)
  await expect.poll(() => optionTexts(page)).toEqual(NAMES)
  await expect(page.getByTestId('settings-microphone-allow')).toHaveCount(0)

  // A device that was chosen once and is not there now.
  await appModules(page, [VOICE_STORE])
  await page.evaluate((path) => {
    const { useVoiceStore } = (window as unknown as AppWindow).__APP__[path]
    useVoiceStore.getState().updateVoiceSettings({ micId: 'unplugged-device', micLabel: 'Desk microphone' })
  }, VOICE_STORE)
  await expect.poll(() => optionTexts(page)).toEqual([
    'System default', 'Fake Audio Input 1', 'Fake Audio Input 2', 'Desk microphone (not connected)',
  ])
  await expect(page.getByTestId('settings-microphone')).toHaveValue('unplugged-device')
  await expect(page.getByTestId('settings-microphone-hint')).toContainText('Desk microphone is not connected, so the system default is used until it is back.')
  await proof(page, '3-chosen-microphone-unplugged')

  const before = (await opened(page)).length
  await dictateOnce(page)
  const takes = (await opened(page)).slice(before)
  // The chosen one was refused, the default one was opened instead.
  expect(takes).toEqual([{ wanted: null, label: 'Fake Default Audio Input' }])
  const kept = await page.evaluate((path) => {
    const { micId, micLabel } = (window as unknown as AppWindow).__APP__[path].useVoiceStore.getState()
    return { micId, micLabel }
  }, VOICE_STORE)
  expect(kept).toEqual({ micId: 'unplugged-device', micLabel: 'Desk microphone' })
})

test('a refused microphone is said in plain words and leaves the list as it was', async ({ page }) => {
  await boot(page, 'refused')
  await openSpeechSettings(page)
  await page.getByTestId('settings-microphone-allow').click()
  await expect(page.getByRole('alert').filter({ hasText: 'microphone' })).toHaveText('The microphone is blocked for this app.')
  expect(await optionTexts(page)).toEqual(['System default'])
  await proof(page, '4-access-refused')
})
