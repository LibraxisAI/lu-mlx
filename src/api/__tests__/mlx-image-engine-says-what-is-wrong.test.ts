// @vitest-environment jsdom
/**
 * Fehlerkontrolle Mac, 08.10.2026. What the frontend does with the three new
 * answers of `mlx_status`:
 *
 *   Fund 2  a half installed engine reads `installed: false`, so the setup
 *           runs again instead of being skipped for good
 *   Fund 7  an Intel Mac is told why, before any setup starts
 *   Fund 8  a sidecar that died on its way up is reported with its reason at
 *           once, not after two timeouts as "mlx unreachable"
 *
 * Run: npx vitest run src/api/__tests__/mlx-image-engine-says-what-is-wrong.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type Reply = unknown | ((args: unknown) => unknown)
let replies: Record<string, Reply> = {}
const calls: string[] = []

vi.mock('../backend', () => ({
  backendCall: async (cmd: string, payload?: { args?: unknown }) => {
    calls.push(cmd)
    if (!(cmd in replies)) throw new Error(`unexpected command: ${cmd}`)
    const reply = replies[cmd]
    return typeof reply === 'function' ? (reply as (a: unknown) => unknown)(payload?.args) : reply
  },
  isTauri: () => true,
  isMacOS: () => true,
}))

import { generateMlxImageDataUrl, waitForMlxRunning } from '../mlx-image'
import { installMlxModel, installMlxStack } from '../mlx-install'
import { useMlxMedia, forgetMlxMediaForTest } from '../../hooks/useMlxMedia'

const INTEL = 'Local image generation needs Apple Silicon. On this Mac, image generation is available in LU Cloud.'
const status = (over: Record<string, unknown>) => ({
  installed: false,
  broken: false,
  appleSilicon: true,
  unsupported: null,
  running: false,
  startError: null,
  port: 47712,
  ...over,
})

beforeEach(() => {
  replies = {}
  calls.length = 0
  // The hook draws from its last read while it reads again. Each test starts
  // from a page that has read nothing.
  forgetMlxMediaForTest()
})

describe('a sidecar that died while starting', () => {
  it('ends the wait with its reason on the first poll', async () => {
    const reason = 'The image engine is incomplete (missing package: uvicorn). Set it up again in the Model Manager.'
    replies.mlx_status = status({ installed: true, startError: reason })
    const begun = Date.now()
    await expect(waitForMlxRunning(30_000, 10)).rejects.toThrow(reason)
    expect(Date.now() - begun).toBeLessThan(2_000)
  })

  it('reaches the user as the error of the render', async () => {
    const reason = 'The image engine could not start because port 47712 is used by another program. Quit that program, then try again.'
    let started = false
    replies.mlx_status = () => status({ installed: true, startError: started ? reason : null })
    replies.mlx_start = () => {
      started = true
      return { ok: true, port: 47712 }
    }
    await expect(generateMlxImageDataUrl({ prompt: 'a fox' })).rejects.toThrow(reason)
    expect(calls).not.toContain('mlx_generate')
  })

  it('still waits for a server that is only slow', async () => {
    let polls = 0
    replies.mlx_status = () => status({ installed: true, running: ++polls >= 3 })
    await expect(waitForMlxRunning(5_000, 5)).resolves.toBeUndefined()
    expect(polls).toBe(3)
  })
})

describe('an engine that cannot run', () => {
  it('a half installed engine is not rendered with', async () => {
    replies.mlx_status = status({ broken: true })
    await expect(generateMlxImageDataUrl({ prompt: 'a fox' })).rejects.toThrow(/incomplete\. Set it up again/)
    expect(calls).toEqual(['mlx_status'])
  })

  it('a half installed engine is set up again before a model is pulled', async () => {
    // What an aborted setup leaves behind. Rust used to call this installed,
    // and the engine step was skipped for good.
    replies.mlx_status = status({ broken: true })
    replies.install_mlx_diffusion = { ok: true, status: 'installing' }
    replies.install_mlx_diffusion_status = { status: 'error', logs: [], error: 'stop here' }
    await expect(installMlxModel('image', { id: 'sd-turbo', name: 'SD Turbo' })).rejects.toThrow('stop here')
    expect(calls).toContain('install_mlx_diffusion')
    expect(calls).not.toContain('mlx_image_install_model')
  })

  it('an Intel Mac starts no setup and says why', async () => {
    replies.mlx_status = status({ appleSilicon: false, unsupported: INTEL })
    await expect(installMlxModel('image', { id: 'sd-turbo', name: 'SD Turbo' })).rejects.toThrow(INTEL)
    await expect(installMlxStack('image')).rejects.toThrow(INTEL)
    await expect(generateMlxImageDataUrl({ prompt: 'a fox' })).rejects.toThrow(INTEL)
    expect(calls.filter((c) => c !== 'mlx_status')).toEqual([])
  })

  it('the Model Manager shows the image lane as unsupported there', async () => {
    replies.mlx_status = status({ appleSilicon: false, unsupported: INTEL })
    replies.mlx_image_models = []
    replies.video_status = { available: false, appleSilicon: false, mlxInstalled: false, installedModels: [], running: false }
    replies.video_list_models = []
    replies.install_mlx_diffusion_status = { status: 'idle', logs: [], error: null }
    replies.mlx_image_install_status = { status: 'idle', logs: [], error: null }
    replies.video_install_mlx_status = { status: 'idle', logs: [], error: null }
    replies.video_install_model_status = { status: 'idle', logs: [], error: null }
    const { result } = renderHook(() => useMlxMedia(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.image.unsupported).toBe(INTEL)
    expect(result.current.image.engineReady).toBe(false)
    expect(result.current.video.unsupported).toMatch(/Apple Silicon/)
  })

  it('a working Mac has no such notice, with or without the new fields', async () => {
    replies.mlx_status = { installed: true, running: true, port: 47712 }
    replies.mlx_image_models = []
    replies.video_status = { available: true, appleSilicon: true, mlxInstalled: true, installedModels: [], running: false }
    replies.video_list_models = []
    for (const cmd of ['install_mlx_diffusion_status', 'mlx_image_install_status', 'video_install_mlx_status', 'video_install_model_status']) {
      replies[cmd] = { status: 'idle', logs: [], error: null }
    }
    const { result } = renderHook(() => useMlxMedia(true))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.image.unsupported).toBeNull()
    expect(result.current.image.engineReady).toBe(true)
  })
})
