import { test, expect } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, signInViaGate, cloudSwitch } from './support/cloud-mock'

/**
 * C10 (Testfenster-Bericht 34501513, e2e/testfenster/BERICHT.md): the picker
 * never showed the "No Filter" mark for any cloud model, because
 * `toModelEntry()` in `src/api/providers/openai-provider.ts` never copied
 * `unfiltered` out of the raw `/v1/models` row. `e2e/cloud-model-picker.spec.ts`
 * did not catch this: it drives the picker against the LIVE catalogue (and is
 * skipped entirely without test credentials), and it only checks the
 * tool-calling mark, never this one. This spec mocks the catalogue response
 * the way `flash-chat-billing.spec.ts` already does for the sibling `flash`
 * field, so the mark is checked against a real, controlled server answer
 * instead of production's current (possibly also broken) state.
 *
 * Run: npx playwright test e2e/no-refusals-mark.spec.ts
 */
test('a measured unfiltered model shows the No Filter mark in the picker', async ({ page }) => {
  await page.addInitScript(tauriMockInit, { assistantReply: DEFAULT_ASSISTANT_REPLY, modelName: DEFAULT_MODEL_NAME })
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true })
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }
  await page.route('**/api/inference/v1/models', (route) => route.fulfill({
    status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({
      object: 'list',
      data: [
        { id: 'measured-full', name: 'Measured Full', context_length: 32768, unfiltered: 'full' },
        // Deliberately fully mainstream and NOT measured, in the same
        // response: a mark that showed for every row regardless of the
        // field would pass the first assertion alone.
        { id: 'measured-partial', name: 'Measured Partial', context_length: 32768, unfiltered: 'partial' },
        { id: 'unmeasured', name: 'Unmeasured', context_length: 32768 },
      ],
    }),
  }))
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible()
  await signInViaGate(page)
  await expect(cloudSwitch(page)).toBeChecked()
  await page.getByRole('button', { name: /New Chat/i }).first().click()
  await page.getByRole('button', { name: 'Select chat model', exact: true }).click()

  const fullRow = page.getByRole('button', { name: /Measured Full/ })
  await fullRow.scrollIntoViewIfNeeded()
  const mark = fullRow.getByText('No Filter', { exact: true })
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAttribute(
    'title',
    "Measured: this model answers without refusing. Your account's content policy still applies.",
  )

  // Gegenprobe: 'partial' is deliberately never marked (ModelRowMarks.tsx),
  // and a server that says nothing gets no mark either. Both rows sit in the
  // SAME response as the passing one, so a mark that leaked onto every row
  // would fail here, not just be absent from a separate run.
  const partialRow = page.getByRole('button', { name: /Measured Partial/ })
  await partialRow.scrollIntoViewIfNeeded()
  await expect(partialRow.getByText('No Filter', { exact: true })).toHaveCount(0)

  const unmeasuredRow = page.getByRole('button', { name: /^Unmeasured/ })
  await unmeasuredRow.scrollIntoViewIfNeeded()
  await expect(unmeasuredRow.getByText('No Filter', { exact: true })).toHaveCount(0)
})
