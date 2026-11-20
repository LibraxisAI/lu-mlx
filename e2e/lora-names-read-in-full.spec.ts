import { test, expect, type Page } from '@playwright/test'
import { bootWithFakeComfy, openImageExpert } from './support/fake-comfy'

/**
 * GitHub discussion #150: in the advanced settings of Create long LoRA names
 * were cut off, so LoRAs whose names start alike could not be told apart.
 * The stack shows every name in full now: a long one takes more lines.
 */

const TWINS = [
  'cinematic_film_grain_photoreal_portrait_lighting_xl_v2_epoch_08_rank32.safetensors',
  'cinematic_film_grain_photoreal_portrait_lighting_xl_v2_epoch_12_rank64.safetensors',
]
const SHORT = 'film_grain_xl.safetensors'
const stem = (file: string) => file.replace('.safetensors', '')

async function boot(page: Page) {
  await bootWithFakeComfy(page, { checkpoints: ['juggernautXL.safetensors'], loras: [...TWINS, SHORT], imageModel: 'juggernautXL.safetensors' })
  await openImageExpert(page)
}

/** Whether the element shows all of its text: nothing clipped, nothing behind an ellipsis. */
const showsAllOfItsText = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).evaluate((el) => {
    const box = el.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(el)
    const ink = range.getBoundingClientRect()
    // Sideways only: a line of text is a little taller than its line box in
    // WebKit, and nothing clips it there.
    return getComputedStyle(el).textOverflow !== 'ellipsis' && el.scrollWidth <= el.clientWidth + 1
      && ink.left >= box.left - 1 && ink.right <= box.right + 1
  })

test('two LoRAs that start alike are both readable to their last letter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 })
  await boot(page)
  await expect(page.getByRole('button', { name: stem(TWINS[0]) })).toBeVisible()
  await page.getByRole('button', { name: stem(SHORT) }).scrollIntoViewIfNeeded()
  if (process.env.LU_SHOTS) {
    // The Expert group is still unfolding: the picture waits, the checks below do not need to.
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${process.env.LU_SHOTS}/lora-names-${process.env.LU_SHOT_TAG ?? 'after'}.png` })
  }
  for (const file of TWINS) {
    const row = page.getByRole('button', { name: stem(file) })
    await expect(row).toBeVisible()
    expect(await showsAllOfItsText(page, stem(file)), `${stem(file)} is cut off`).toBe(true)
    // The row stays inside the drawer: no sideways scrolling for a long name.
    const fits = await row.evaluate((el) => {
      const drawer = el.closest('aside') as HTMLElement
      const list = el.parentElement?.parentElement as HTMLElement
      // One pixel of slack: under the app's zoom the engines round differently.
      return el.getBoundingClientRect().right <= drawer.getBoundingClientRect().right && list.scrollWidth <= list.clientWidth + 1
    })
    expect(fits, 'the row leaves the drawer').toBe(true)
    await expect(row).toHaveAttribute('title', file)
  }
})

test('a long name keeps its state word and its strength, and a short one stays one line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
  const long = page.getByRole('button', { name: stem(TWINS[1]) })
  await long.click()
  await expect(page.getByText('· 1 active')).toBeVisible()
  // "on" stays whole next to a name that takes several lines.
  const word = long.getByText('on', { exact: true })
  await expect(word).toBeVisible()
  expect(await word.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await expect(page.getByRole('textbox', { name: `Strength of ${stem(TWINS[1])}` })).toHaveValue('0.80')

  const short = page.getByText(stem(SHORT), { exact: true })
  const lines = await short.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))
  expect(lines).toBe(1)

  // The drawer is still a popup with an X, and Escape closes it.
  await expect(page.getByRole('main').getByRole('button', { name: 'Close' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(/^LoRA stack/)).toHaveCount(0)
})
