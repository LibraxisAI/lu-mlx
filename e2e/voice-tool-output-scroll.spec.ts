import { test, expect, type Locator, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, type AppWindow } from './support/ui'

/**
 * A long tool output in a voice session can be read: opened, scrolled inside
 * its own box, and the transcript around it scrolled up, also in a window
 * that fills the screen and while the session keeps running.
 *
 * 08.10.2026: "Web Search and other tool output cannot be scrolled in
 * Voice in full screen." The transcript pinned itself to its end on every
 * change of its height, and opening a result is such a change.
 */

const SHOTS = process.env.LU_VOICE_SHOTS

// 180 lines: long enough to need scrolling, short enough that the card keeps all of it.
const RESULT = Array.from({ length: 180 }, (_, i) => `${i + 1}. Cloud AI subscription result number ${i + 1}: a title, a link and two lines of summary text.`).join('\n')

async function boot(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size)
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
  })
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'mac' as const,
    voiceLoop: { installed: true, session: { port: 9, token: 'e2e-launch-token'.padEnd(64, '0') } },
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(page.getByTestId('voice-view')).toBeVisible()
}

/** Wait until an element stands still: the surface moves for a moment when a session starts or a block opens. */
async function settled(page: Page, target: Locator) {
  await expect.poll(async () => {
    const first = await target.boundingBox()
    await page.waitForTimeout(150)
    const second = await target.boundingBox()
    return first !== null && second !== null && first.y === second.y && first.height === second.height
  }).toBe(true)
}

/** A live session with a few turns and one web search that returned a lot. */
async function sessionWithLongOutput(page: Page, result: string, turns = 6) {
  await appModules(page, ['/src/stores/voiceSessionStore.ts'])
  await page.evaluate(({ text, turns }) => {
    const { useVoiceSessionStore } = (window as unknown as AppWindow).__APP__['/src/stores/voiceSessionStore.ts']
    const send = useVoiceSessionStore.getState().dispatch
    send({ type: 'start', at: Date.now(), muted: false })
    send({ type: 'brain', modelLabel: 'Qwen3.5 9B', notice: null })
    send({ type: 'ready' })
    for (let turn = 1; turn <= turns; turn++) {
      send({ type: 'user-text', text: `Question number ${turn}, long enough to fill a line of the transcript.`, final: true })
      send({ type: 'bot-text', text: `Answer number ${turn}. It has two sentences so the transcript grows.` })
      send({ type: 'bot-silent' })
    }
    send({ type: 'user-text', text: 'Search the web for cloud AI subscriptions.', final: true })
    send({ type: 'tool-running', id: 'call-search', name: 'web_search', args: { query: 'cloud AI subscriptions' } })
    send({ type: 'tool-done', id: 'call-search', status: 'completed', result: text, durationMs: 1200 })
    send({ type: 'bot-text', text: 'I found several plans around twenty dollars a month.' })
    send({ type: 'bot-silent' })
  }, { text: result, turns })
}

for (const size of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
  test(`a long tool output scrolls at ${size.width} by ${size.height}`, async ({ page }) => {
    await boot(page, size)
    // Enough turns that the transcript is longer than the tallest window.
    await sessionWithLongOutput(page, RESULT, 30)
    const view = page.getByTestId('voice-view')
    const transcript = view.getByTestId('voice-transcript')
    const block = view.locator('[data-tool="web_search"]')
    await expect(block).toHaveAttribute('data-status', 'completed')

    // Open the result.
    await block.getByRole('button').first().click()
    const output = block.locator('pre').last()
    await expect(output).toContainText('1. Cloud AI subscription result number 1:')

    // The block opens with a short animation: wait until it stands still.
    await settled(page, output)
    // The box of the result scrolls by the wheel, down to its last line.
    const box = (await output.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    expect(await output.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    await page.mouse.wheel(0, 600)
    await expect.poll(() => output.evaluate((node) => node.scrollTop)).toBeGreaterThan(300)
    await output.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await expect(output).toContainText('180. Cloud AI subscription result number 180:')

    // The transcript scrolls up, and it stays where the reader put it while
    // the session goes on: a new line does not pull it back to the end.
    const edge = (await transcript.boundingBox())!
    await page.mouse.move(edge.x + 20, edge.y + 20)
    await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await page.mouse.wheel(0, -400)
    await expect.poll(() => transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(200)
    const kept = await transcript.evaluate((node) => node.scrollTop)
    await appModules(page, ['/src/stores/voiceSessionStore.ts'])
    await page.evaluate(() => {
      const { useVoiceSessionStore } = (window as unknown as AppWindow).__APP__['/src/stores/voiceSessionStore.ts']
      const send = useVoiceSessionStore.getState().dispatch
      send({ type: 'bot-thinking' })
      send({ type: 'bot-text', text: 'One more thing while you are reading further up.' })
    })
    await expect(view.getByText('One more thing while you are reading further up.')).toBeAttached()
    await page.waitForTimeout(300)
    expect(Math.abs((await transcript.evaluate((node) => node.scrollTop)) - kept)).toBeLessThanOrEqual(2)

    // Back at the end, the transcript follows again.
    await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await appModules(page, ['/src/stores/voiceSessionStore.ts'])
    await page.evaluate(() => {
      const { useVoiceSessionStore } = (window as unknown as AppWindow).__APP__['/src/stores/voiceSessionStore.ts']
      useVoiceSessionStore.getState().dispatch({ type: 'bot-text', text: ' And this follows at the end.' })
    })
    await expect.poll(() => transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(4)
    if (SHOTS && size.width === 1920) await page.screenshot({ path: `${SHOTS}/f4-tool-output-1920x1080.png` })
  })
}

test('opening a result further up keeps the reader at the result, not at the end of the transcript', async ({ page }) => {
  await boot(page, { width: 1920, height: 1080 })
  await sessionWithLongOutput(page, RESULT, 12)
  // The talk went on after the search: the result is no longer at the end.
  await appModules(page, ['/src/stores/voiceSessionStore.ts'])
  await page.evaluate(() => {
    const { useVoiceSessionStore } = (window as unknown as AppWindow).__APP__['/src/stores/voiceSessionStore.ts']
    const send = useVoiceSessionStore.getState().dispatch
    for (let turn = 1; turn <= 14; turn++) {
      send({ type: 'user-text', text: `Later question number ${turn}, long enough to fill a line of the transcript.`, final: true })
      send({ type: 'bot-text', text: `Later answer number ${turn}. It has two sentences so the transcript grows.` })
      send({ type: 'bot-silent' })
    }
  })
  const view = page.getByTestId('voice-view')
  const transcript = view.getByTestId('voice-transcript')
  const block = view.locator('[data-tool="web_search"]')
  await settled(page, transcript)
  // Scroll up to the search, then open it.
  await block.evaluate((node) => node.scrollIntoView({ block: 'center' }))
  await expect.poll(() => transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(200)
  const before = await transcript.evaluate((node) => node.scrollTop)
  await block.getByRole('button').first().click()
  const output = block.locator('pre').last()
  await expect(output).toBeVisible()
  await settled(page, output)
  expect(Math.abs((await transcript.evaluate((node) => node.scrollTop)) - before)).toBeLessThanOrEqual(2)
  await expect(block.getByRole('button').first()).toBeInViewport()
  await expect(output).toBeInViewport()
})
