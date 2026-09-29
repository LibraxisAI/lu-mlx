/**
 * @vitest-environment jsdom
 *
 * The Models folder field writes `models_root` in config.json — not
 * `hfDownloadPathOverride`, which is the LU Engine GGUF folder.
 *
 * Run: npx vitest run src/components/settings/__tests__/models-root-setting.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
}))

const { ModelsRootSetting } = await import('../ModelsRootSetting')

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string, args?: { path?: string }) => {
    if (cmd === 'get_models_root') return { path: '/workspace/lu-models' }
    if (cmd === 'set_models_root') return { status: 'saved', path: args?.path || null }
    if (cmd === 'pick_folder') return '/Volumes/Other/models'
    throw new Error(`unexpected command ${cmd}`)
  })
})
afterEach(cleanup)

describe('ModelsRootSetting', () => {
  it('is named Models folder and says it is not the LU Engine GGUF folder', async () => {
    render(createElement(ModelsRootSetting))
    await settle()
    expect(screen.getByText('Models folder')).toBeTruthy()
    expect(screen.getByText(/not the LU Engine GGUF folder/)).toBeTruthy()
    expect((screen.getByLabelText('Models folder') as HTMLInputElement).value).toBe('/workspace/lu-models')
  })

  it('saves a typed path through set_models_root', async () => {
    render(createElement(ModelsRootSetting))
    await settle()
    const field = screen.getByLabelText('Models folder') as HTMLInputElement
    fireEvent.change(field, { target: { value: '/tmp/lu-models' } })
    fireEvent.blur(field)
    await settle()
    expect(backendCall).toHaveBeenCalledWith('set_models_root', { path: '/tmp/lu-models' })
  })

  it('the folder picker writes the chosen path', async () => {
    render(createElement(ModelsRootSetting))
    await settle()
    fireEvent.click(screen.getByText('Browse'))
    await settle()
    expect(backendCall).toHaveBeenCalledWith('pick_folder')
    expect(backendCall).toHaveBeenCalledWith('set_models_root', { path: '/Volumes/Other/models' })
  })
})
