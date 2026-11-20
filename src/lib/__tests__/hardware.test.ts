import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.hoisted(() => vi.fn())
vi.mock('../../api/backend', () => ({ backendCall: (cmd: string) => backendCall(cmd) }))

import { meetsImageGenThreshold, getSharedMemoryGb, getMaxVramGb } from '../hardware'

// ═══════════════════════════════════════════════════════════════
//  hardware — image-gen capability threshold (VRAM≥12 OR RAM≥16)
// ═══════════════════════════════════════════════════════════════

describe('meetsImageGenThreshold', () => {
  it('passes on enough VRAM alone', () => {
    expect(meetsImageGenThreshold(12, 8)).toBe(true)   // 12GB VRAM, 8GB RAM
    expect(meetsImageGenThreshold(24, 8)).toBe(true)
  })

  it('passes on enough RAM alone', () => {
    expect(meetsImageGenThreshold(0, 16)).toBe(true)   // no GPU, 16GB RAM
    expect(meetsImageGenThreshold(6, 32)).toBe(true)
  })

  it('fails when below both thresholds', () => {
    expect(meetsImageGenThreshold(8, 8)).toBe(false)
    expect(meetsImageGenThreshold(11.9, 15.9)).toBe(false)
    expect(meetsImageGenThreshold(0, 0)).toBe(false)
  })

  it('treats the thresholds as inclusive (≥)', () => {
    expect(meetsImageGenThreshold(12, 0)).toBe(true)
    expect(meetsImageGenThreshold(0, 16)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
//  hardware: the one memory pool of a Mac
//
//  Fehlerkontrolle Mac 2, Fund 3. `detect_gpus` carries the pool as
//  `shared_memory_mib` on the Apple entry (gpu.rs, b5337f07) and leaves
//  `memory_mib` null there on purpose. `system_info` is the fallback.
// ═══════════════════════════════════════════════════════════════

describe('getSharedMemoryGb', () => {
  const GB = 1_073_741_824
  const apple = (shared: number | null) => ({ index: 0, vendor: 'apple', name: 'Apple M2 Pro', memory_mib: null, shared_memory_mib: shared, source: 'system' })
  function machine(gpus: unknown, totalMemory: number | 'fails') {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'detect_gpus') { if (gpus === 'fails') throw new Error('no probe'); return gpus }
      if (cmd === 'system_info') { if (totalMemory === 'fails') throw new Error('no sysinfo'); return { totalMemory } }
      throw new Error(`unexpected ${cmd}`)
    })
  }
  beforeEach(() => { backendCall.mockReset() })

  it('reads shared_memory_mib from the Apple entry and does not need system_info', async () => {
    machine([apple(32 * 1024)], 'fails')
    expect(await getSharedMemoryGb()).toBe(32)
  })

  it('prefers the probe over system_info when both answer', async () => {
    machine([apple(16 * 1024)], 15.6 * GB)
    expect(await getSharedMemoryGb()).toBe(16)
  })

  it('falls back to system_info when the entry carries no pool', async () => {
    machine([apple(null)], 8 * GB)
    expect(await getSharedMemoryGb()).toBe(8)
  })

  it('falls back to system_info when the entry is from a build before the field', async () => {
    machine([{ index: 0, vendor: 'apple', name: 'Apple M1', memory_mib: null, source: 'system' }], 8 * GB)
    expect(await getSharedMemoryGb()).toBe(8)
  })

  it('falls back to system_info when the probe fails outright', async () => {
    machine('fails', 24 * GB)
    expect(await getSharedMemoryGb()).toBe(24)
  })

  it('answers 0, not a guess, when nothing answers', async () => {
    machine('fails', 'fails')
    expect(await getSharedMemoryGb()).toBe(0)
  })

  it('CONTROL: the pool is not a card. getMaxVramGb stays 0 on a Mac', async () => {
    machine([apple(32 * 1024)], 32 * GB)
    expect(await getMaxVramGb()).toBe(0)
  })

  it('WINDOWS CONTROL: a PC card is read as before and carries no shared pool', async () => {
    machine([{ index: 0, vendor: 'nvidia', name: 'RTX 3060', memory_mib: 12288, shared_memory_mib: null, source: 'nvidia-smi' }], 32 * GB)
    expect(await getMaxVramGb()).toBe(12)
  })
})
