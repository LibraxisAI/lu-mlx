// The Mac's LoRA folder as the Model Manager and Settings read it: where it
// is and what is in it (api/mlx-loras). Read on mount, again when a download
// lands in it or a file is deleted through the app, and on demand.

import { useCallback, useEffect, useState } from 'react'
import { listMlxLoras, MLX_LORAS_CHANGED, type MlxLora } from '../api/mlx-loras'

export interface MlxLoraFolder {
  /** False until the first reading has come back. */
  loaded: boolean
  dir: string
  loras: MlxLora[]
  /** Why the folder could not be read, or null. */
  error: string | null
  refresh: () => Promise<void>
}

export function useMlxLoras(enabled: boolean): MlxLoraFolder {
  const [state, setState] = useState<{ loaded: boolean; dir: string; loras: MlxLora[]; error: string | null }>(
    { loaded: false, dir: '', loras: [], error: null },
  )

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const listing = await listMlxLoras()
      setState({ loaded: true, dir: listing.dir, loras: listing.loras, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const again = () => { void refresh() }
    // A finished download says so with this event on every platform; on the
    // Mac a LoRA from the CivitAI search is one of them.
    window.addEventListener('comfyui-model-downloaded', again)
    window.addEventListener(MLX_LORAS_CHANGED, again)
    return () => {
      window.removeEventListener('comfyui-model-downloaded', again)
      window.removeEventListener(MLX_LORAS_CHANGED, again)
    }
  }, [enabled, refresh])

  return { ...state, refresh }
}
