/**
 * R2-51: the VRAM advisory on ModelsStep used to ask ONLY the running
 * ComfyUI's own /system_stats (`getSystemVRAM`, api/comfyui.ts). On this very
 * step, before ComfyUI has necessarily been started, that meant the memory
 * warning next to an oversized model was silent almost all the time, not
 * because the machine had enough VRAM, but because nothing had asked yet.
 *
 * `getMaxVramGb` (lib/hardware.ts) asks the Rust `detect_gpus` probe
 * (nvidia-smi/rocm-smi/lspci/wmic), which needs no engine running at all.
 * ComfyUI's own number stays the fallback for whatever `detect_gpus` could
 * not name (it fails soft to 0, which reads as "unknown", not "no VRAM").
 *
 * Source-level, matching the codebase's own pattern for a hook effect deep
 * inside a large component (see loop-stops-on-terminal.test.ts): what has to
 * hold is the call order, not a full render of a 500+ line step.
 *
 * Run: npx vitest run src/components/onboarding/__tests__/vram-advisory-prefers-rust-probe.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getMaxVramGb } from '../../../lib/hardware'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../ModelsStep.tsx'), 'utf8')

describe('R2-51: ModelsStep prefers the Rust GPU probe over ComfyUI for the VRAM advisory', () => {
  it('imports getMaxVramGb from lib/hardware', () => {
    // `getSharedMemoryGb` rides along since the Mac reads its memory pool here
    // (mac-empfehlung-folgt-dem-speicher.test.tsx); the probe this guard is
    // about still comes from the same file.
    expect(src).toMatch(/import \{ getMaxVramGb(?:, getSharedMemoryGb)? \} from '\.\.\/\.\.\/lib\/hardware'/)
  })

  it('calls getMaxVramGb before falling back to getSystemVRAM', () => {
    const rust = src.indexOf('getMaxVramGb()')
    const comfy = src.indexOf('getSystemVRAM()')
    expect(rust).toBeGreaterThan(-1)
    expect(comfy).toBeGreaterThan(-1)
    expect(rust).toBeLessThan(comfy)
  })

  it('only falls back to ComfyUI when the Rust probe found nothing (v > 0 short-circuits)', () => {
    const at = src.indexOf('getMaxVramGb().then')
    const block = src.slice(at, src.indexOf('}, [])', at))
    expect(block).toMatch(/if\s*\(v > 0\)/)
  })

  it('a failed Rust probe (rejected promise) still falls back to ComfyUI, not to a stuck null', () => {
    const at = src.indexOf('getMaxVramGb().then')
    const block = src.slice(at, src.indexOf('}, [])', at) + 10)
    expect(block).toContain('.catch(() => {')
    // Two independent fallback paths: the `v === 0` branch inside `.then`,
    // and the `.catch` for a thrown/rejected probe, both must call
    // getSystemVRAM, or a rejected detect_gpus call would leave the
    // advisory permanently null even though ComfyUI could still answer.
    const comfyCalls = block.split('getSystemVRAM()').length - 1
    expect(comfyCalls).toBe(2)
  })
})

describe('R2-51: NEGATIVE CONTROL, getMaxVramGb genuinely needs no ComfyUI', () => {
  it('is documented to fail soft to 0 rather than throw when detect_gpus is unavailable', async () => {
    // Exercises the real function (no engine, no Tauri) to prove the claim
    // in ModelsStep's new comment: a probe failure here is silent, not a
    // crash that would take the fallback down with it.
    await expect(getMaxVramGb()).resolves.toBeTypeOf('number')
  })
})
