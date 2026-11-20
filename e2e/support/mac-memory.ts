import type { Page } from '@playwright/test'

/**
 * Gives the mocked machine a size. The Tauri mock answers no hardware probe,
 * so every surface that names this Mac's memory (the hardware chip, "Fits my
 * Mac", the verdict on a tile) is silent under it. Call this AFTER
 * `page.addInitScript(tauriMockInit, ...)`: init scripts run in the order they
 * were added, and this one wraps the router the mock has installed.
 *
 * `ramGb` is what `system_info` reports. `vramGb` is what `detect_gpus`
 * reports; on a Mac that is the same shared pool, on a PC it is the card.
 */
export async function giveMachineMemory(page: Page, memory: { ramGb: number; vramGb?: number }) {
  await page.addInitScript((m: { ramGb: number; vramGb?: number }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown, o?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    if (!internals) return
    const inner = internals.invoke.bind(internals)
    internals.invoke = (cmd: string, args?: unknown, o?: unknown) => {
      if (cmd === 'system_info') return Promise.resolve({ totalMemory: m.ramGb * 1_073_741_824 })
      if (cmd === 'detect_gpus') {
        return Promise.resolve(m.vramGb
          ? [{ index: 0, vendor: 'test', name: 'Test GPU', memory_mib: m.vramGb * 1024, source: 'e2e' }]
          : [])
      }
      return inner(cmd, args, o)
    }
  }, memory)
}
