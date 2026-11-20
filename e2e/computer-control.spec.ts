import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_MODEL_NAME, DEFAULT_ASSISTANT_REPLY, type TauriMockOptions } from './support/tauri-mock'
import { seedOnboardingDone } from './support/cloud-mock'
import { appModules, type AppWindow } from './support/ui'

/**
 * Computer control as the user meets it: the switch in the permission
 * settings (off), the question per app with its four answers, the
 * confirmation per action, both above the chat input and no longer as a
 * dialog at the top, the status bar with Stop, the calm refusal for a
 * blocked app, and "Always allow" in the settings where it can be taken back.
 *
 * The Rust side is the mock (e2e/support/tauri-mock.ts), which keeps the
 * rules commands/computer.rs keeps. The tool is called the way the agent
 * loop calls it: through the registry of the running app.
 */

const SHOTS = process.env.LU_COMPUTER_SHOTS
// The app's own module, loaded in the page: Vite serves one instance per URL.
const MCP_URL = '/src/api/mcp/index.ts'
interface McpModule {
  toolRegistry: {
    execute(name: string, args: unknown, depth: number, run: { token: string }): Promise<string>
    getAll(): { name: string }[]
  }
}

async function boot(page: Page, computer: TauriMockOptions['computer'] = {}) {
  await page.addInitScript(tauriMockInit, {
    assistantReply: DEFAULT_ASSISTANT_REPLY,
    modelName: DEFAULT_MODEL_NAME,
    platform: 'windows' as const,
    // This file is the window that stays a window, with its bar (Linux, and
    // wherever shrinking is not available). The panel is in
    // computer-surface.spec.ts.
    computer: { shrinks: false, ...computer },
  })
  await seedOnboardingDone(page)
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
}

// The picture waits for fades to end.
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${SHOTS}/${name}` })
}

async function openPermissions(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  const section = page.getByTestId('computer-control-settings')
  // The section is folded until the user opens it.
  if (!(await section.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Agent Permissions', exact: true }).click()
  }
  await section.scrollIntoViewIfNeeded()
  await expect(section).toBeVisible()
  return section
}

async function turnOn(page: Page) {
  const section = await openPermissions(page)
  await section.getByRole('button', { name: 'Computer control' }).click()
  await page.getByRole('banner').getByRole('button', { name: 'Chat' }).click()
}

/** Start a tool call in the page and leave it running. */
async function callTool(page: Page, args: Record<string, unknown>, token = 'run-1') {
  await page.evaluate(
    ([toolArgs, runToken, url]) => {
      const w = window as unknown as { __COMPUTER_RESULTS__?: string[] }
      w.__COMPUTER_RESULTS__ = w.__COMPUTER_RESULTS__ ?? []
      // The same module instance the app uses: Vite serves one per URL.
      void (import(/* @vite-ignore */ url) as Promise<McpModule>).then((m) =>
        m.toolRegistry.execute('computer_use', toolArgs, 0, { token: runToken }).then((r) => { w.__COMPUTER_RESULTS__!.push(r) }),
      )
    },
    [args, token, MCP_URL] as const,
  )
}

const results = (page: Page) => page.evaluate(() => (window as unknown as { __COMPUTER_RESULTS__?: string[] }).__COMPUTER_RESULTS__ ?? [])
const fired = (page: Page) => page.evaluate(() => (window as unknown as { __E2E_COMPUTER_FIRED__?: unknown[] }).__E2E_COMPUTER_FIRED__ ?? [])
const offered = (page: Page) => appModules(page, [MCP_URL]).then(() =>
  page.evaluate((url) => ((window as unknown as AppWindow).__APP__[url] as McpModule).toolRegistry.getAll().map((t) => t.name), MCP_URL))

test('computer control is off until the user turns it on in the permission settings', async ({ page }) => {
  await boot(page)
  expect(await offered(page)).not.toContain('computer_use')
  await callTool(page, { action: 'click', x: 500, y: 500 })
  await expect.poll(() => results(page)).toEqual([expect.stringMatching(/Unknown tool "computer_use"/)])

  const section = await openPermissions(page)
  await expect(section).toContainText('Lets a model see your screen and use mouse and keyboard in apps you approve.')
  await expect(section).toContainText('Always off limits, and not a setting')
  await expect(section).toContainText('None. An app lands here when you choose "Always allow"')
  await shot(page, '01-settings-off.png')

  await section.getByRole('button', { name: 'Computer control' }).click()
  expect(await offered(page)).toContain('computer_use')
  await shot(page, '02-settings-on.png')
  await section.getByRole('button', { name: 'Computer control' }).click()
  expect(await offered(page)).not.toContain('computer_use')
  await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
})

test('the first action in an app asks for the app, then for the action, and only then runs', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  await callTool(page, { action: 'click', x: 500, y: 300 })

  const app = page.getByRole('group', { name: 'Allow LU to control Notepad?' })
  await expect(app).toBeVisible()
  await expect(app).toContainText('C:\\Windows\\System32\\notepad.exe')
  await expect(app).toContainText('Terminals, password managers, system dialogs and LU itself stay off limits')
  for (const name of ['Allow once', 'Allow for this session', 'Always allow', 'Deny']) {
    await expect(app.getByRole('button', { name, exact: true })).toBeVisible()
  }
  // It is a surface above the chat input, not a dialog and not a message.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const input = page.getByRole('textbox').last()
  const appBox = (await app.boundingBox())!
  const inputBox = (await input.boundingBox())!
  expect(appBox.y + appBox.height).toBeLessThanOrEqual(inputBox.y + 1)
  expect(inputBox.y - (appBox.y + appBox.height)).toBeLessThan(40)
  await expect(page.locator('[data-message-id]').filter({ has: app })).toHaveCount(0)
  // The way out has the focus: an Enter meant for the message field must not allow an app.
  await expect(app.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
  // The status bar is up while LU holds a session, with Stop and its shortcut.
  const bar = page.getByTestId('computer-control-bar')
  await expect(bar).toContainText('LU is controlling this computer')
  // While a question is open the bar is short and Stop names its shortcut.
  await expect(bar.getByTestId('computer-stop')).toContainText('Ctrl+Alt+Esc')
  expect(await fired(page)).toEqual([])
  await shot(page, '03-app-question.png')

  await app.getByRole('button', { name: 'Allow for this session' }).click()
  const confirm = page.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText('Click at 500, 300 in Notepad')
  await expect(confirm).toContainText('Supervised: you confirm every action.')
  expect(await fired(page)).toEqual([])
  await shot(page, '04-action-confirmation.png')

  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(1)
  await expect.poll(() => results(page)).toEqual([expect.stringMatching(/^Did click in Notepad\.\nScreenshot \[screen frame 1\]/)])
  await expect(bar).toContainText('in Notepad')
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  await expect(bar).toContainText('Supervised: you confirm every action.')
  await expect(bar).toContainText('Press Ctrl+Alt+Esc anywhere to stop, Ctrl+Alt+Space to pause.')
  await shot(page, '05-status-bar.png')

  // The same app is not asked for again in this session; the action still is.
  await callTool(page, { action: 'type', text: 'Hello from LU' })
  await expect(page.getByRole('group', { name: 'Confirm this action' })).toContainText('Type in Notepad: Hello from LU')
  await page.getByTestId('computer-question').getByRole('button', { name: 'Decline' }).click()
  await expect.poll(() => results(page)).toHaveLength(2)
  expect((await results(page))[1]).toMatch(/^Error: The user declined this action\./)
  expect(await fired(page)).toHaveLength(1)
})

test('the bar leaves a few seconds after the work is done, and in a small window it covers no navigation', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  await page.setViewportSize({ width: 900, height: 600 })
  await callTool(page, { action: 'click', x: 500, y: 300 })
  await page.getByTestId('computer-question').getByRole('button', { name: 'Allow for this session' }).click()
  await page.getByRole('group', { name: 'Confirm this action' }).getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => results(page)).toHaveLength(1)

  const bar = page.getByTestId('computer-control-bar')
  await expect(bar).toContainText('Supervised: you confirm every action.')
  // Inside the main panel: not over the header with the navigation, not over the sidebar.
  // (The panel is measured again within half a second of a change in size.)
  await expect(async () => {
    const box = (await bar.boundingBox())!
    const main = (await page.locator('main').boundingBox())!
    const header = (await page.getByRole('banner').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(main.x)
    expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width)
    expect(box.y).toBeGreaterThanOrEqual(header.y + header.height)
    expect(box.y).toBeGreaterThan(main.y)
  }).toPass({ timeout: 2000 })
  await shot(page, '06-status-bar-900x600.png')

  // Nothing is running and nothing is asked: the bar goes, the session stays.
  await expect(bar).toHaveCount(0, { timeout: 8000 })
  const session = () => appModules(page, ['/src/stores/computerStore.ts']).then(() => page.evaluate(() => {
    const { useComputerStore } = (window as unknown as AppWindow).__APP__['/src/stores/computerStore.ts']
    return useComputerStore.getState().session?.id ?? null
  }))
  expect(await session()).not.toBeNull()

  // The next action brings it back, and the app is not asked for again.
  await callTool(page, { action: 'type', text: 'Hello' })
  await expect(page.getByRole('group', { name: 'Confirm this action' })).toBeVisible()
  await expect(bar).toBeVisible()
  await expect(page.getByRole('group', { name: /Allow LU to control/ })).toHaveCount(0)
  await page.getByTestId('computer-question').getByRole('button', { name: 'Decline' }).click()
})

test('Deny and Escape both mean no', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  for (const close of ['deny', 'escape'] as const) {
    await callTool(page, { action: 'key', keys: 'ctrl+s' })
    const app = page.getByRole('group', { name: 'Allow LU to control Notepad?' })
    await expect(app).toBeVisible()
    if (close === 'deny') await app.getByRole('button', { name: 'Deny' }).click()
    else await page.keyboard.press('Escape')
    await expect(app).toHaveCount(0)
  }
  await expect.poll(() => results(page)).toHaveLength(2)
  for (const result of await results(page)) expect(result).toMatch(/^Error: The user did not allow LU to control Notepad\./)
  expect(await fired(page)).toEqual([])
})

test('"Always allow" lands in the permission settings and can be taken back there', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  await callTool(page, { action: 'click', x: 10, y: 10 })
  await page.getByTestId('computer-question').getByRole('button', { name: 'Always allow' }).click()
  await page.getByRole('group', { name: 'Confirm this action' }).getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(1)

  // It survives a restart of the app: the switch, this list and the chosen screen model are what is persisted.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('locally-uncensored-computer') ?? '{}'))
  expect(stored.state).toEqual({ enabled: true, alwaysAllowed: [{ key: 'notepad.exe', name: 'Notepad' }], executorModel: null, screenInput: 'auto' })

  const section = await openPermissions(page)
  await expect(section.getByRole('listitem')).toContainText(['Notepad'])
  await expect(section).toContainText('notepad.exe')
  await shot(page, '06-always-allowed.png')
  await section.getByRole('button', { name: 'Stop always allowing Notepad' }).click()
  await expect(section).toContainText('None. An app lands here')

  // Taken back at once: the next action asks for the app again.
  await page.getByRole('banner').getByRole('button', { name: 'Chat' }).click()
  await callTool(page, { action: 'click', x: 10, y: 10 })
  await expect(page.getByRole('group', { name: 'Allow LU to control Notepad?' })).toBeVisible()
})

test('a blocked app gets no question, only a calm line', async ({ page }) => {
  await boot(page, { app: { key: 'windowsterminal.exe', name: 'Windows Terminal' }, blocked: true })
  await turnOn(page)
  await callTool(page, { action: 'type', text: 'del /s /q C:\\' })
  await expect.poll(() => results(page)).toEqual(['Error: Terminals and shells are always off limits for computer control.'])
  await expect(page.getByTestId('computer-question')).toHaveCount(0)
  await expect(page.getByTestId('computer-notice')).toContainText('Terminals and shells are always off limits for computer control.')
  expect(await fired(page)).toEqual([])
  await shot(page, '07-blocked-app.png')
})

test('Stop ends it: the waiting question is answered with no and the run cannot go on', async ({ page }) => {
  await boot(page)
  await turnOn(page)
  await callTool(page, { action: 'click', x: 500, y: 300 })
  await page.getByTestId('computer-question').getByRole('button', { name: 'Allow for this session' }).click()
  await expect(page.getByRole('group', { name: 'Confirm this action' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => results(page)).toHaveLength(1)

  await callTool(page, { action: 'wait', ms: 1 })
  await expect.poll(() => results(page)).toHaveLength(2)
  await page.getByTestId('computer-stop').click()
  // The stop is told by the small note above the input field, and the bar is gone.
  const note = page.getByTestId('computer-note')
  await expect(note).toContainText('Computer control stopped. The user stopped computer control.')
  await expect(page.getByTestId('computer-control-bar')).toHaveCount(0)
  await shot(page, '08-stopped.png')

  await callTool(page, { action: 'click', x: 500, y: 300 })
  await expect.poll(() => results(page)).toHaveLength(3)
  expect((await results(page))[2]).toMatch(/^Error: The user stopped computer control\. Do not continue with computer_use/)
  expect(await fired(page)).toEqual([])
  await expect(page.getByTestId('computer-question')).toHaveCount(0)

  await note.getByRole('button', { name: 'Dismiss' }).click()
  await expect(note).toHaveCount(0)
})

test('a supervised session says why a sensitive action is one, in red, and offers no way around the question', async ({ page }) => {
  await boot(page, { sensitive: true })
  await turnOn(page)
  // An ordinary action of the same session: no reason, and the switch to Autonomous is offered.
  await callTool(page, { action: 'key', keys: 'tab' })
  await page.getByTestId('computer-question').getByRole('button', { name: 'Allow for this session' }).click()
  const confirm = page.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm).toContainText('Supervised: you confirm every action.')
  await expect(confirm.getByTestId('computer-confirm-reason')).toHaveCount(0)
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(1)

  // The click on "Send": the reason stands in the question, as in an autonomous session.
  await callTool(page, { action: 'click', x: 800, y: 900 })
  await expect(confirm.getByTestId('computer-confirm-reason')).toContainText('The click target "Send" contains "send"')
  await expect(confirm).toContainText('LU asks before anything that sends, buys, deletes or changes permissions')
  await expect(confirm.getByRole('switch', { name: 'Autonomous' })).toHaveCount(0)
  expect(await fired(page)).toHaveLength(1)
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(2)
})

test('an autonomous session asks only before a sensitive action and says why', async ({ page }) => {
  await boot(page, { sensitive: true })
  await turnOn(page)
  await callTool(page, { action: 'key', keys: 'tab' })
  await page.getByTestId('computer-question').getByRole('button', { name: 'Allow for this session' }).click()
  await page.getByRole('group', { name: 'Confirm this action' }).getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(1)

  const bar = page.getByTestId('computer-control-bar')
  await bar.getByRole('button', { name: 'Autonomous' }).click()
  await expect(bar).toContainText('Autonomous for this session: LU asks only before sending, buying, deleting or changing permissions.')

  await callTool(page, { action: 'key', keys: 'tab' })
  await expect.poll(() => fired(page)).toHaveLength(2)
  await expect(page.getByTestId('computer-question')).toHaveCount(0)

  await callTool(page, { action: 'click', x: 800, y: 900 })
  const confirm = page.getByRole('group', { name: 'Confirm this action' })
  await expect(confirm.getByTestId('computer-confirm-reason')).toContainText('The click target "Send" contains "send"')
  await expect(confirm).toContainText('also in an autonomous session')
  await shot(page, '09-sensitive-in-autonomous.png')
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => fired(page)).toHaveLength(3)

  // Autonomy is not a setting: it is not on disk.
  const stored = await page.evaluate(() => localStorage.getItem('locally-uncensored-computer') ?? '')
  expect(stored).not.toContain('autonomous')
})

test('text on the screen that addresses the model is flagged', async ({ page }) => {
  await boot(page, { injection: true })
  await turnOn(page)
  await callTool(page, { action: 'read_tree' })
  await page.getByTestId('computer-question').getByRole('button', { name: 'Allow for this session' }).click()
  await expect.poll(() => results(page)).toHaveLength(1)
  const [result] = await results(page)
  expect(result).toContain('<screen_data>')
  expect(result).toMatch(/Warning: text on the screen looks like instructions for an AI \("ignore previous instructions"\)/)
  await expect(page.getByTestId('computer-notice')).toContainText('Text on the screen looks like instructions for an AI. LU told the model to ignore it.')
  await shot(page, '10-injection-warning.png')
})
