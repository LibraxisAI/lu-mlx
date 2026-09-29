import { useState, useEffect, useRef, useCallback } from 'react'
import { galleryItemUrl, mustProxyComfyView, proxiedComfyBlobUrl, recoverGalleryUrl, markGalleryItemAvailable } from './galleryUrl'
import { isComfyLocal, isMacOS, isTauri } from '../../../api/backend'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'

/**
 * Display src for a gallery item's `<img>`/`<video>`.
 *
 * ComfyUI 0.19+ answers the webview's cross-origin `<img src="…/view">` with
 * 403 (Sec-Fetch-Site), and the webview logs that before onError can run.
 * On macOS ComfyUI is always the user's own instance (LU never spawns it
 * there) and usually runs without CORS headers, so in the Mac app we never
 * assign that URL: bytes come through the Rust proxy (no Origin header) as a
 * blob, and nothing is requested while ComfyUI is down.
 *
 * Windows/Linux keep the direct /view: LU starts its own ComfyUI with
 * `--enable-cors-header "*"`, and the direct load keeps Range requests, so a
 * long video still seeks and is not held whole in memory. A ComfyUI 0.19+ that
 * still refuses it falls back through `onError` to the same proxy (#75), which
 * also raises the --enable-cors-header hint for a local host.
 * Dev mode keeps the same-origin Vite proxy path.
 */
export function useComfyMedia(item: GalleryItem | null) {
  const base = item ? galleryItemUrl(item) : ''
  const comfyRunning = useCreateStore((s) => s.comfyRunning)
  // Cross-origin /view is the 403. Same-origin `/comfyui/view` (dev) is fine.
  const blockDirectView = mustProxyComfyView(base, { tauri: isTauri(), mac: isMacOS() })
  const [proxied, setProxied] = useState<{ base: string; url: string } | null>(null)
  const src = proxied && proxied.base === base ? proxied.url : (blockDirectView ? '' : base)
  const blobRef = useRef<string | null>(null)
  const triedProxy = useRef(false)

  useEffect(() => {
    triedProxy.current = false
    return () => {
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current)
        blobRef.current = null
      }
    }
  }, [base])

  useEffect(() => {
    if (!item || !blockDirectView) return
    // Bytes we own on disk are not a Comfy output. Re-read the file; do not
    // ask /view for a name ComfyUI never wrote.
    if (item.localPath && !item.dataUrl) {
      recoverGalleryUrl(item)
      return
    }
    if (!comfyRunning) return
    let cancelled = false
    triedProxy.current = true
    void proxiedComfyBlobUrl(item).then((blob) => {
      if (cancelled) {
        if (blob) URL.revokeObjectURL(blob)
        return
      }
      if (blob) {
        blobRef.current = blob
        setProxied({ base, url: blob })
      } else {
        recoverGalleryUrl(item)
      }
    })
    return () => { cancelled = true }
  }, [item, base, blockDirectView, comfyRunning])

  const onError = useCallback(() => {
    if (!item) return
    if (triedProxy.current) {
      recoverGalleryUrl(item)
      return
    }
    triedProxy.current = true
    void proxiedComfyBlobUrl(item).then((blob) => {
      if (blob) {
        blobRef.current = blob
        setProxied({ base, url: blob })
        if (isComfyLocal()) useCreateStore.getState().setComfyCorsBlocked(true)
      } else {
        recoverGalleryUrl(item)
      }
    })
  }, [item, base])

  const onLoad = useCallback(() => { if (item) markGalleryItemAvailable(item) }, [item])

  return { src, onError, onLoad }
}
