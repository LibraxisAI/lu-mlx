import { useEffect, useRef, useState } from 'react'
import { withDetail } from '../../lib/error-text'
import { backendCall } from '../../api/backend'

/**
 * Where LU stores heavy models (MLX weights, built-in GGUFs, HF cache).
 *
 * This is NOT the LU Engine GGUF folder (`hfDownloadPathOverride`). Rust
 * `configured_models_root()` reads `models_root` from config.json, then
 * `LU_MODELS_ROOT`. Empty here removes the key so callers fall back to their
 * per-feature defaults.
 */
export function ModelsRootSetting() {
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const pendingPath = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    void backendCall<{ path: string | null }>('get_models_root')
      .then((r) => {
        if (!alive) return
        const path = typeof r?.path === 'string' ? r.path : ''
        setDraft(path)
        setSaved(path)
      })
      .catch((e) => {
        if (alive) setSaveError(withDetail('Could not read the models folder from config.json.', e))
      })
    return () => { alive = false }
  }, [])

  async function commit(next: string) {
    pendingPath.current = null
    const trimmed = next.trim()
    if (trimmed === saved) return
    setSaveError(null)
    try {
      const r = await backendCall<{ status: string; path: string | null }>('set_models_root', { path: trimmed })
      const path = typeof r?.path === 'string' ? r.path : ''
      setDraft(path)
      setSaved(path)
    } catch (e) {
      setSaveError(withDetail('Could not save the models folder.', e))
    }
  }

  function typePath(next: string) {
    setDraft(next)
    pendingPath.current = next
  }

  useEffect(() => () => {
    const owed = pendingPath.current
    pendingPath.current = null
    if (owed === null) return
    const trimmed = owed.trim()
    if (trimmed === saved) return
    void backendCall('set_models_root', { path: trimmed }).catch(() => { /* unmount */ })
  }, [saved])

  async function pickFolder() {
    setPickError(null)
    try {
      const chosen = await backendCall<string | null>('pick_folder')
      if (chosen) {
        setDraft(chosen)
        await commit(chosen)
      }
    } catch (e) {
      setPickError(withDetail('The folder picker did not open. Type or paste the path into the field instead.', e))
    }
  }

  return (
    <div className="space-y-2 py-1">
      <p className="t-micro font-semibold text-gray-700 dark:text-gray-300">Models folder</p>
      <div className="t-micro text-gray-500 leading-relaxed">
        Root for heavy local models: MLX image/video weights, the built-in GGUF folder, and the Hugging Face cache (`hf-home`). Leave it empty to use LU&apos;s own folders. This is not the LU Engine GGUF folder below.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => typePath(e.target.value)}
          onBlur={() => { void commit(draft) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void commit(draft) }}
          placeholder="Empty = LU's own folders"
          aria-label="Models folder"
          className="flex-1 px-2 py-1 rounded bg-transparent border border-white/8 t-mono text-gray-700 dark:text-gray-300 focus:outline-none focus:border-white/20"
        />
        <button
          onClick={() => { void pickFolder() }}
          className="px-2.5 py-1 rounded-md t-micro font-medium bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
        >
          Browse
        </button>
      </div>
      {pickError && <p role="alert" className="t-micro text-red-400 leading-relaxed">{pickError}</p>}
      {saveError && <p role="alert" className="t-micro text-red-400 leading-relaxed">{saveError}</p>}
    </div>
  )
}
