/**
 * GH #135 (2026-09-15): "Install engine" under `npm run dev`
 * answered "Unknown backend command: install_mlx_diffusion".
 *
 * Run: npx vitest run src/api/__tests__/mlx-says-dev-mode-instead-of-unknown-command.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let tauri = false
const backendCall = vi.fn(async (cmd: string) => { throw new Error(`Unknown backend command: ${cmd}`) })
vi.mock('../backend', () => ({
  backendCall: (cmd: string) => backendCall(cmd),
  isTauri: () => tauri,
  isMacOS: () => true,
}))

import { MLX_DEV_MODE_ERROR } from '../mlx-invoke'
import { installMlxImageEngine } from '../mlx-image'
import { installMlxVideo } from '../mlx-video'

beforeEach(() => { backendCall.mockClear(); tauri = false })

describe('MLX outside the desktop app', () => {
  it('the image engine install says which dev command to use', async () => {
    await expect(installMlxImageEngine()).rejects.toThrow(MLX_DEV_MODE_ERROR)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('the video engine install says the same', async () => {
    await expect(installMlxVideo()).rejects.toThrow(MLX_DEV_MODE_ERROR)
  })

  it('inside the desktop app the command goes to Rust as before', async () => {
    tauri = true
    await expect(installMlxImageEngine()).rejects.toThrow(/Unknown backend command/)
    expect(backendCall).toHaveBeenCalledWith('install_mlx_diffusion')
  })
})
