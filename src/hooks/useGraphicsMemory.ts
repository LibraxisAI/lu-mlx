/**
 * How much graphics memory this machine has, for the hints that compare a
 * model with it. One reading for the Model Manager and for Create, so the two
 * cannot name different cards.
 *
 * Two probes, best wins, exactly as the Model Manager always did it:
 * `detect_gpus` (nvidia-smi, rocm-smi, the Windows registry; works without
 * ComfyUI running) and the running ComfyUI's own /system_stats.
 *
 * The answer is kept for the life of the app. A card does not change while it
 * runs, `detect_gpus` shells out, and the waiting area mounts this on every
 * render. Nothing is kept while both probes come back empty, so a ComfyUI that
 * starts later is still asked.
 */
import { useEffect, useState } from 'react'
import { getMaxVramGb } from '../lib/hardware'
import { getSystemVRAM } from '../api/comfyui'
import { isMacOS } from '../api/backend'

let known: number | null = null

/** Forget the kept reading. Tests only. */
export function forgetGraphicsMemory(): void {
  known = null
}

/** Graphics memory in whole GB, null until a probe has answered. */
export function useGraphicsMemoryGb(): number | null {
  const [gb, setGb] = useState<number | null>(known)
  useEffect(() => {
    if (known !== null) return
    let alive = true
    const take = (v: number | null) => {
      if (!v || v <= 0) return
      known = Math.max(known ?? 0, Math.round(v))
      if (alive) setGb(known)
    }
    getMaxVramGb().then(take).catch(() => {})
    getSystemVRAM().then(take).catch(() => {})
    return () => { alive = false }
  }, [])
  return gb
}

/**
 * The same number, but only where it is a graphics card of its own. On a Mac
 * the figure is the memory pool the processor shares, and a line that says
 * "your 32 GB card" about it would name a card nobody owns.
 */
export function useGraphicsCardGb(): number | null {
  const gb = useGraphicsMemoryGb()
  return isMacOS() ? null : gb
}
