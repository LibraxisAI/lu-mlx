import { useCallback, useEffect, useState } from 'react'
import { addImagePart, catalogImagePartFor, fileNameOf, findImagePartSource } from '../api/image-part-install'
import type { ImagePartSource } from '../api/discover'
import { useDownloadStore } from '../stores/downloadStore'
import { addImageInputLabel, canAddImagePart, imagePartFileName } from '../lib/image-part'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../lib/lmstudio-match'
import type { DownloadProgress } from '../types/downloads'

/** The part of a model entry this hook reads. */
export interface ImagePartModel {
  name?: string
  path?: string
  provider?: string
  providerName?: string
  supportsVision?: boolean
  imagePartInstalled?: boolean
}

export interface ImagePartOffer {
  /** Show the one click that adds the image part. */
  offer: boolean
  /** "Add image input (0.9 GB)". */
  label: string
  /** The part is on its way. */
  downloading: DownloadProgress | null
  /** The model has its image part on disk and was loaded without it. */
  loadedWithout: boolean
  /** What went wrong on the last click, as a sentence. */
  error: string | null
  add: () => void
}

/**
 * What the app can do about the image part of ONE installed model.
 *
 * Only for a GGUF of the LU Engine: the other local runtimes keep the part
 * inside the model they manage. The catalog answers at once; a model the
 * catalog does not know is looked up in the repository it was downloaded
 * from, once per session.
 */
export function useImagePartOffer(model: ImagePartModel | null | undefined, label?: string): ImagePartOffer {
  const path = model && isBuiltinEngineEntry(model as InstalledModelLike) && typeof model.path === 'string' ? model.path : null
  const file = path ? fileNameOf(path) : null
  const present = model?.imagePartInstalled === true
  const [looked, setLooked] = useState<{ file: string; source: ImagePartSource | null } | null>(null)
  const [error, setError] = useState<{ file: string; text: string } | null>(null)
  const row = useDownloadStore((s) => (file ? s.downloads[imagePartFileName(file)] ?? null : null))

  // The catalog is asked while rendering, the repository in an effect.
  const fromCatalog = file ? catalogImagePartFor(file) : null
  useEffect(() => {
    if (!file || present || fromCatalog) return
    let live = true
    void findImagePartSource(file).then((source) => { if (live) setLooked({ file, source }) })
    return () => { live = false }
  }, [file, present, fromCatalog])
  const source = fromCatalog ?? (looked && looked.file === file ? looked.source : null)

  const running = row && row.status !== 'complete' && row.status !== 'error' ? row : null
  const add = useCallback(() => {
    if (!path || !file) return
    setError(null)
    addImagePart(path, label).catch((e) => {
      setError({ file, text: e instanceof Error ? e.message : String(e) })
    })
  }, [path, file, label])

  return {
    // Only on the engine's own word that the part is missing. A list that
    // does not say (an older engine) gets no offer rather than a wrong one.
    offer: !!file && !running && model?.imagePartInstalled === false && canAddImagePart({ present, source }),
    label: addImageInputLabel(source?.sizeBytes),
    downloading: running,
    loadedWithout: present && model?.supportsVision === false,
    error: row?.status === 'error' ? row.error ?? 'The image part did not download.' : error && error.file === file ? error.text : null,
    add,
  }
}
