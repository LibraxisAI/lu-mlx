import { test, expect, type Page } from '@playwright/test'
import { tauriMockInit, DEFAULT_ASSISTANT_REPLY, DEFAULT_MODEL_NAME, type TauriMockOptions } from './support/tauri-mock'
import { routeCloud, seedOnboardingDone, cloudSwitch } from './support/cloud-mock'
import { mlxCalls } from './support/recorded'
import { gradientPng } from './support/png'
import { expectDataFetchRefused, serveWithAppPolicy, type PolicyDirective } from './support/app-policy'

/**
 * The app's connect-src has no data: entry, so fetch() on a data: URL fails
 * in the packaged app with a bare "Load failed" while it works on the dev
 * server. The gallery pick was the first place found (see
 * create-edit-gallery-source.spec.ts). These are the others of the same
 * build, each run under the policy of tauri.conf.json.
 *
 * Where no click leads to the code on a mocked bridge, the test calls the
 * app's own module in the page, so the policy of the page still decides.
 */

const MAC: TauriMockOptions = {
  assistantReply: DEFAULT_ASSISTANT_REPLY,
  modelName: DEFAULT_MODEL_NAME,
  platform: 'mac',
  mlx: { installedImages: ['sd-turbo', 'qwen-image-2.1-8bit'], mfluxEngineInstalled: true },
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** 50 ms of 16 bit mono silence. */
function wav(): Buffer {
  const samples = 400
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + samples * 2, 4)
  head.write('WAVEfmt ', 8, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(8000, 24)
  head.writeUInt32LE(16000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(samples * 2, 40)
  return Buffer.concat([head, Buffer.alloc(samples * 2)])
}

async function boot(page: Page, policy: PolicyDirective[] = ['connect-src']) {
  await serveWithAppPolicy(page, policy)
  await page.addInitScript(tauriMockInit, MAC)
  await seedOnboardingDone(page)
  await routeCloud(page, { license: 'active', access: true, mediaLive: true, paidPlan: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(cloudSwitch(page)).toBeVisible({ timeout: 20_000 })
  await expectDataFetchRefused(page)
}

test('a GIF is taken as the Edit source: its PNG copy is read without fetch', async ({ page }) => {
  await boot(page)
  await page.getByRole('banner').getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('radio', { name: 'Edit / Image to Image', exact: true }).click()
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({ name: 'loop.gif', mimeType: 'image/gif', buffer: GIF })

  await expect(page.getByRole('img', { name: 'source' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Could not load the image/)).toHaveCount(0)
  // The copy really went to disk for the local engine, with bytes in it.
  const staged = (await mlxCalls(page)).filter((c) => c.cmd === 'video_stage_start_image')
  expect(staged).toHaveLength(1)
})

test('an image picked in cloud mode gets its local file from the data: URL', async ({ page }) => {
  await boot(page)
  const url = `data:image/png;base64,${gradientPng(64, 48).toString('base64')}`
  const ref = await page.evaluate(async ([path, dataUrl]) => {
    const mod = (await import(/* @vite-ignore */ path)) as {
      ensureLocalFilename: (ref: { filename: string; url: string; width: number; height: number }, name: string) => Promise<{ filename: string }>
    }
    return mod.ensureLocalFilename({ filename: '', url: dataUrl, width: 64, height: 48 }, 'picked.png').then((r) => r.filename, (e: unknown) => `failed: ${String(e)}`)
  }, ['/src/components/create/experimental/loadImage.ts', url] as const)
  expect(ref).toBe('/tmp/lu-e2e/videos/start-images/e2e-start.png')
})

test('Download saves a gallery item that only has a data: URL', async ({ page }) => {
  await boot(page)
  const picture = gradientPng(64, 48)
  const saved = await page.evaluate(async ([path, dataUrl]) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } }
    const saves: { name: unknown; size: number }[] = []
    const invoke = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command !== 'save_binary_file_dialog') return invoke(command, args)
      saves.push({ name: args.defaultName, size: (args.bytes as number[]).length })
      return Promise.resolve('/Users/me/Downloads/' + String(args.defaultName))
    }
    const mod = (await import(/* @vite-ignore */ path)) as { downloadGalleryItem: (item: Record<string, unknown>) => Promise<void> }
    await mod.downloadGalleryItem({ id: 'g1', type: 'image', filename: '', subfolder: '', dataUrl })
    return saves
  }, ['/src/components/create/experimental/galleryDownload.ts', `data:image/png;base64,${picture.toString('base64')}`] as const)
  expect(saved).toEqual([{ name: 'lu-g1.png', size: picture.length }])
})

test('the chat model is shown a picture that arrives as a data: URL', async ({ page }) => {
  await boot(page)
  const picture = gradientPng(64, 48).toString('base64')
  const read = await page.evaluate(async ([path, dataUrl]) => {
    const mod = (await import(/* @vite-ignore */ path)) as { fetchComfyImageBase64: (url: string) => Promise<string> }
    return mod.fetchComfyImageBase64(dataUrl).catch((e: unknown) => `failed: ${String(e)}`)
  }, ['/src/api/comfyui.ts', `data:image/png;base64,${picture}`] as const)
  // Not toBe(picture): a miss would print both strings in full.
  expect(read.slice(0, 40)).toBe(picture.slice(0, 40))
  expect(read === picture).toBe(true)
})

for (const kind of ['data', 'blob'] as const) {
  test(`a clip the media element refuses plays through Web Audio from a ${kind}: URL`, async ({ page }) => {
    // media-src has no data: entry either, so the element refuses the clip
    // and the Web Audio way is the one that has to read the bytes.
    await boot(page, ['connect-src', 'media-src'])
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    const outcome = await page.evaluate(async ([path, base64, urlKind]) => {
      const mod = (await import(/* @vite-ignore */ path)) as { playNeuralAudio: (url: string) => Promise<void> }
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      // The element cannot play this container, so both kinds take the fallback.
      const url = urlKind === 'data'
        ? `data:audio/wav;base64,${base64}`
        : URL.createObjectURL(new Blob([bytes], { type: 'application/x-refused' }))
      return mod.playNeuralAudio(url).then(() => 'played', (e: unknown) => String(e))
    }, ['/src/api/voice.ts', wav().toString('base64'), kind] as const)
    expect(outcome).toBe('played')
  })
}
