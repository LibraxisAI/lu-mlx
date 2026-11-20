/**
 * @vitest-environment jsdom
 *
 * Settings, AI Backends, Local Media on a Mac. Until 3.0.6 the panel was a
 * second model list beside the Model Manager, with its own install buttons
 * and its own polling. It is reduced to what a settings page is for: the two
 * engines, the memory a loaded model holds, where the files are, the token
 * hint, and one button that leads to the models.
 *
 * Run: npx vitest run src/components/settings/__tests__/local-media-is-engines-not-a-model-list.test.tsx
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const state = vi.hoisted(() => ({
  engine: { installed: true, running: true, port: 1, modelLoaded: true, modelRepo: 'stabilityai/sd-turbo' as string | null },
  videoInstalled: true,
}))
const mlxUnload = vi.hoisted(() => vi.fn())
const installMlxImageEngine = vi.hoisted(() => vi.fn())
const GB = vi.hoisted(() => 1_000_000_000)
const idle = vi.hoisted(() => ({ status: 'idle', logs: [], error: null }))

vi.mock('../../../api/mlx-image', () => ({
  mlxStatus: vi.fn(async () => ({ ...state.engine })),
  listMlxImageModels: vi.fn().mockResolvedValue([
    { id: 'sd-turbo', name: 'SD Turbo', repo: 'stabilityai/sd-turbo', sizeBytes: 2.6 * GB, minRamGB: 8, unfiltered: false, description: 'd', installed: true },
    { id: 'z-image', name: 'Z-Image', repo: 'Tongyi-MAI/Z-Image', sizeBytes: 20.5 * GB, minRamGB: 32, unfiltered: false, description: 'd', installed: false },
  ]),
  installMlxImageModel: vi.fn(),
  getMlxImageInstallStatus: vi.fn().mockResolvedValue(idle),
  cancelMlxImageInstall: vi.fn(),
  deleteMlxImageModel: vi.fn(),
  installMlxImageEngine,
  getMlxImageEngineStatus: vi.fn().mockResolvedValue({ status: 'complete', logs: [], error: null }),
  mlxUnload,
  hfTokenPresent: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../../api/mlx-video', () => ({
  getVideoStatus: vi.fn(async () => ({
    available: state.videoInstalled, appleSilicon: true, mlxInstalled: state.videoInstalled, mlxVersion: state.videoInstalled ? '0.4.0' : null,
    pythonBin: null, modelsRoot: '/Users/t/Library/Caches/lu/mlx-video', outputsRoot: '/Users/t/lu/videos', installedModels: [], running: false,
  })),
  listVideoModels: vi.fn().mockResolvedValue([
    { id: 'wan21-t2v-1.3b', name: 'Wan 2.1 T2V 1.3B', repo: 'Wan-AI/Wan2.1-T2V-1.3B', sizeBytes: 18 * GB, minRamGB: 16, unfiltered: false, description: 'd', installed: true },
  ]),
  installMlxVideo: vi.fn(),
  getMlxInstallStatus: vi.fn().mockResolvedValue(idle),
  installVideoModel: vi.fn(),
  getModelInstallStatus: vi.fn().mockResolvedValue(idle),
  cancelVideoModelInstall: vi.fn(),
  deleteVideoModel: vi.fn(),
}))

import { MlxMediaSettings } from '../MlxMediaSettings'
import { useUIStore } from '../../../stores/uiStore'
import { useModelStore } from '../../../stores/modelStore'
import { useMlxInstallStore } from '../../../stores/mlxInstallStore'
import { formatBytes } from '../../../lib/formatters'

beforeEach(() => {
  state.engine = { installed: true, running: true, port: 1, modelLoaded: true, modelRepo: 'stabilityai/sd-turbo' }
  state.videoInstalled = true
  mlxUnload.mockReset().mockImplementation(async () => {
    state.engine = { ...state.engine, modelLoaded: false, modelRepo: null }
    return { ok: true, was_loaded: true, running: true }
  })
  installMlxImageEngine.mockReset().mockResolvedValue({ ok: true, status: 'installing' })
  useMlxInstallStore.setState({ entries: {} })
  useUIStore.setState({ currentView: 'settings' })
})
afterEach(cleanup)

describe('Local Media in Settings is about the engines, not a second model list', () => {
  it('lists no model: no row, no install or remove button for one', async () => {
    render(createElement(MlxMediaSettings))
    await screen.findByText(/2 models installed/)
    expect(screen.queryByText('SD Turbo')).toBeNull()
    expect(screen.queryByText('Z-Image')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Install$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('counts what is installed and leads to the Model Manager, on the Image rail', async () => {
    useModelStore.setState({ categoryFilter: 'text' })
    render(createElement(MlxMediaSettings))
    // 2.6 GB and 18 GB are installed; the 20.5 GB one is not counted.
    const sum = formatBytes(2.6 * GB + 18 * GB)
    expect((await screen.findByText(/2 models installed/)).textContent).toContain(`2 models installed, ${sum}.`)
    fireEvent.click(screen.getByRole('button', { name: 'Manage models' }))
    expect(useUIStore.getState().currentView).toBe('models')
    expect(useModelStore.getState().categoryFilter).toBe('image')
  })

  it('shows both engines as set up, with what they report', async () => {
    render(createElement(MlxMediaSettings))
    expect(await screen.findByText('Set up and running.')).toBeTruthy()
    expect(screen.getByText('Set up, MLX 0.4.0.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Set up the/ })).toBeNull()
  })

  it('a missing engine offers its one setup, through the shared install path', async () => {
    state.engine = { installed: false, running: false, port: 1, modelLoaded: false, modelRepo: null }
    render(createElement(MlxMediaSettings))
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the image engine' }))
    await waitFor(() => expect(installMlxImageEngine).toHaveBeenCalledTimes(1))
    // The titlebar tray follows the same slot: the install is in the shared store.
    await waitFor(() => expect(useMlxInstallStore.getState().entries['image-engine']).toBeTruthy())
  })

  it('Free memory hands back what the loaded model holds, and then has nothing left to free', async () => {
    render(createElement(MlxMediaSettings))
    expect(await screen.findByText(/stabilityai\/sd-turbo is loaded and holds memory/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Free memory' }))
    await waitFor(() => expect(mlxUnload).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('No image model is held in memory right now.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Free memory' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('names where the files are and whether a token is set', async () => {
    render(createElement(MlxMediaSettings))
    expect(await screen.findByText('/Users/t/Library/Caches/lu/mlx-video')).toBeTruthy()
    expect(screen.getByText('/Users/t/lu/videos')).toBeTruthy()
    expect(await screen.findByText(/A Hugging Face token is set\./)).toBeTruthy()
  })

  it('STRUCTURE: the panel holds no install logic of its own', () => {
    const src = readFileSync(resolve(__dirname, '..', 'MlxMediaSettings.tsx'), 'utf-8')
    expect(src).toContain("useMlxMedia(true)")
    expect(src).not.toMatch(/setInterval|installMlxImageModel|installVideoModel|deleteMlxImageModel|deleteVideoModel|getMlxImageInstallStatus|getModelInstallStatus/)
  })
})
