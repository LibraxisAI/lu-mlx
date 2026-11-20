// @vitest-environment jsdom
/**
 * Fehlerkontrolle Mac 3, 08.10.2026, on the side of the interface:
 *
 *   Fund 8   Cancel on an image of the first engine (the sidecar) sent
 *            nothing at all. It now sends `mlx_generate_cancel`, as it does
 *            for the second engine.
 *   Fund 12  The Cancel is repeated until the request is back, and by then
 *            the next image can be running. Every run has a name, and the
 *            Cancel carries the name of its own.
 *   Fund 9   The steps and the guidance a sidecar image took reach the
 *            caller, so the gallery does not write the slider's value.
 *
 * Run: npx vitest run src/api/__tests__/mlx-image-cancel-reaches-the-sidecar.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface Call { cmd: string; args: Record<string, unknown> }
const calls: Call[] = []
let catalogue: Array<Record<string, unknown>> = []
/** Ends the `mlx_generate` that is waiting. */
let finish: ((reply: unknown) => void) | null = null
let fail: ((why: Error) => void) | null = null

vi.mock('../backend', () => ({
  backendCall: async (cmd: string, payload?: { args?: Record<string, unknown> }) => {
    calls.push({ cmd, args: payload?.args ?? {} })
    if (cmd === 'mlx_status') return { installed: true, running: true, mfluxInstalled: true, port: 47712 }
    if (cmd === 'mlx_image_models') return catalogue
    if (cmd === 'mlx_generate_progress') return { running: false, step: 0, steps: 0 }
    if (cmd === 'mlx_generate_cancel') return { ok: true, stopped: true }
    if (cmd === 'mlx_generate') return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    throw new Error(`unexpected command: ${cmd}`)
  },
  isTauri: () => true,
  isMacOS: () => true,
}))

import { generateMlxImageDataUrl } from '../mlx-image'

const sent = (cmd: string) => calls.filter((c) => c.cmd === cmd)
const until = async (what: () => boolean) => {
  for (let i = 0; i < 200 && !what(); i++) await Promise.resolve()
  expect(what()).toBe(true)
}

beforeEach(() => {
  calls.length = 0
  finish = null
  fail = null
  catalogue = [
    { id: 'sd-turbo', name: 'SD Turbo', family: 'diffusers', sizeGB: 2, installed: true },
    { id: 'qwen-image-2.1-8bit', name: 'Qwen-Image 2.1 8-bit', family: 'mflux', userSampling: true, sizeGB: 18, installed: true },
  ]
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

describe('Cancel on an image in the sidecar', () => {
  it('asks the engine to stop, by the name of the run', async () => {
    const stop = new AbortController()
    const run = generateMlxImageDataUrl({ prompt: 'a cat', model: 'sd-turbo', steps: 4 }, { signal: stop.signal })
    run.catch(() => null)
    await until(() => sent('mlx_generate').length === 1)
    const name = sent('mlx_generate')[0].args.run
    expect(typeof name === 'string' && name.length > 0, 'the run has no name').toBe(true)
    expect(sent('mlx_generate_cancel')).toHaveLength(0)

    stop.abort()
    await until(() => sent('mlx_generate_cancel').length === 1)
    expect(sent('mlx_generate_cancel')[0].args).toEqual({ run: name })

    // The sidecar ends it between two steps, and the request comes back.
    fail!(new Error('The image was cancelled.'))
    await expect(run).rejects.toThrow('The image was cancelled.')
    // Nothing is repeated once the request is back.
    const asked = sent('mlx_generate_cancel').length
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent('mlx_generate_cancel')).toHaveLength(asked)
  })

  it('two runs never carry the same name, and each Cancel names its own', async () => {
    const first = new AbortController()
    const a = generateMlxImageDataUrl({ prompt: 'a cat', model: 'qwen-image-2.1-8bit' }, { signal: first.signal })
    a.catch(() => null)
    await until(() => sent('mlx_generate').length === 1)
    first.abort()
    await until(() => sent('mlx_generate_cancel').length === 1)
    fail!(new Error('stopped'))
    await expect(a).rejects.toThrow()

    const b = generateMlxImageDataUrl({ prompt: 'a dog', model: 'qwen-image-2.1-8bit' })
    await until(() => sent('mlx_generate').length === 2)
    const [old, next] = sent('mlx_generate').map((c) => c.args.run)
    expect(old).not.toBe(next)
    expect(sent('mlx_generate_cancel').every((c) => c.args.run === old)).toBe(true)
    finish!({ image_base64: 'AAAA', width: 1024, height: 1024, steps: 25, guidance: 4 })
    await b
  })
})

describe('what a sidecar image took', () => {
  it('reaches the caller: its steps and the guidance of the catalogue', async () => {
    const run = generateMlxImageDataUrl({ prompt: 'a cat', model: 'sd-turbo', steps: 4, guidance: 7 })
    await until(() => sent('mlx_generate').length === 1)
    // The slider's value is not sent to an engine that does not read it.
    expect(sent('mlx_generate')[0].args).not.toHaveProperty('guidance')
    finish!({ image_base64: 'AAAA', width: 512, height: 512, steps: 4, guidance: 0, output: '/i/mlx-1.png' })
    await expect(run).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AAAA', width: 512, height: 512, localPath: '/i/mlx-1.png', steps: 4, guidance: 0,
    })
  })
})
