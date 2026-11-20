/**
 * @vitest-environment jsdom
 *
 * Box probe 4 (04.10.2026): the drive check refused "LTX 2.5 · Small" with
 * "Not enough free space: 0.5 GB short. ..." and the card stayed on
 * "Installing…" with no Get button until the Models page was left. The card
 * waited for a running download row that a refused install never creates.
 *
 * Measured on the rendered page: click Get, the install is refused, the card
 * says Get again and the reason stands above the cards.
 *
 * Run: npx vitest run src/components/models/__tests__/a-refused-install-gives-the-get-button-back.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { ModelBundle } from '../../../api/model-bundles'

const installBundleComplete = vi.fn(async (_b: ModelBundle): Promise<{ remote?: never }> => ({}))

vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  backendCall: vi.fn(async () => []),
  openExternal: vi.fn(),
  isTauri: () => false,
  isMacOS: () => false,
}))
vi.mock('../../../api/comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/comfyui')>()),
  getSystemVRAM: vi.fn(async () => 24),
  readComfyFolderLists: vi.fn(async () => ({})),
  refreshComfyModels: vi.fn(async () => {}),
}))
vi.mock('../../../api/discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/discover')>()),
  installBundleComplete: (b: ModelBundle) => installBundleComplete(b),
}))
vi.mock('../../../lib/hardware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/hardware')>()),
  getMaxVramGb: vi.fn(async () => 24),
  getTotalRamGb: vi.fn(async () => 64),
}))
vi.mock('../CivitaiSearchPanel', () => ({ CivitaiSearchPanel: () => null }))
vi.mock('../../chat/LuEngineSwitchBar', () => ({ LuEngineSwitchBar: () => null }))

import { DiscoverModels } from '../DiscoverModels'

const NAME = 'LTX 2.5 · Small (GGUF Q4)'
const REFUSAL = 'Not enough free space: 0.5 GB short. The download is 27.1 GB, LU keeps 2.0 GB of the drive free, and the drive has 28.6 GB free. Free up some space and start it again.'
const tile = () => document.querySelector(`[data-bundle-tile="${NAME}"]`) as HTMLElement
const getButton = () => within(tile()).queryByRole('button', { name: /^Get/ })

beforeEach(() => {
  cleanup()
  installBundleComplete.mockReset()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function clickGet() {
  render(<DiscoverModels category="video" />)
  await waitFor(() => expect(tile()).toBeTruthy())
  fireEvent.click(getButton()!)
}

describe('an install that does not start', () => {
  it('refused by the drive check: the reason is shown and the card says Get again', async () => {
    installBundleComplete.mockRejectedValue(new Error(REFUSAL))
    await clickGet()
    expect(await screen.findByText(`${NAME}: ${REFUSAL}`)).toBeTruthy()
    await waitFor(() => expect(getButton()).toBeTruthy())
    expect(within(tile()).queryByText(/Installing/)).toBeNull()
  })

  it('started nothing because every file was cancelled before its first byte: Get again, no endless spinner', async () => {
    installBundleComplete.mockResolvedValue({})
    await clickGet()
    await waitFor(() => expect(installBundleComplete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getButton()).toBeTruthy())
    expect(within(tile()).queryByText(/Installing/)).toBeNull()
  })

  it('says Installing while the install call is still open', async () => {
    let settle: (v: { remote?: never }) => void = () => {}
    installBundleComplete.mockImplementation(() => new Promise((r) => { settle = r }))
    await clickGet()
    expect(await within(tile()).findByText(/Installing/)).toBeTruthy()
    settle({})
    await waitFor(() => expect(getButton()).toBeTruthy())
  })
})
