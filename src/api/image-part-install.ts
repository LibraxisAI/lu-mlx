/**
 * Adding the image part to a model that is already installed.
 *
 * The owner's test machine, October 2026: a Qwen 3.5 9B was on disk, fetched
 * before the catalog named its image part. The app treated it as a model
 * without image input, which was true of the files and wrong about the model,
 * and nothing offered the one missing file.
 *
 * This is the one click. It knows where the part of an installed GGUF comes
 * from (the catalog entry of the same file, or the repository the app once
 * downloaded the file from), fetches it next to the model under the name the
 * engine looks for, and when the model is the one that is loaded, loads it
 * again so that it can see, as soon as no answer is being written.
 *
 * Only the LU Engine's own GGUFs. The other local runtimes keep the image
 * part inside the model they manage, so there is nothing to add from here,
 * only to detect.
 */

import {
  getMainstreamTextModels, getUncensoredTextModels, imagePartOf, resolveHfGgufFiles,
  type ImagePartSource,
} from './discover'
import { startPlannedDownload } from './model-download'
import { bundledEngineStatus, swapBundledModel } from './engine'
import { imagePartFileName } from '../lib/image-part'
import { parseHfUrl, extractGgufQuant } from '../lib/hf-to-provider'
import { whenRunsIdle } from '../lib/run-idle'
import { useDownloadStore } from '../stores/downloadStore'
import { log } from '../lib/logger'

/** File name of a path, on either kind of separator. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Folder of a path, on either kind of separator, without the trailing one. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

/**
 * The image part the CATALOG names for an installed file, or null.
 *
 * Matched on the file name, without regard to case: that is the name the
 * download wrote, and the only thing an installed GGUF and its catalog entry
 * share. A model imported from another tool carries another name and gets no
 * answer here, which is right: nothing proves which part fits it.
 */
export function catalogImagePartFor(modelFile: string): ImagePartSource | null {
  const wanted = modelFile.toLowerCase()
  for (const m of [...getUncensoredTextModels(), ...getMainstreamTextModels()]) {
    if (m.filename?.toLowerCase() === wanted) return imagePartOf(m)
  }
  return null
}

/** Repositories already asked in this session, by model file. */
const asked = new Map<string, Promise<ImagePartSource | null>>()

/**
 * The image part of an installed file: the catalog's, or, for a GGUF the user
 * fetched from a repository of their own, the part that repository ships.
 *
 * The second answer needs the address the file was downloaded from, which the
 * download list keeps across restarts, and one request for the repository's
 * file list. A file whose origin is unknown has no source.
 */
export function findImagePartSource(modelFile: string): Promise<ImagePartSource | null> {
  const fromCatalog = catalogImagePartFor(modelFile)
  if (fromCatalog) return Promise.resolve(fromCatalog)
  const known = asked.get(modelFile)
  if (known) return known
  const origin = useDownloadStore.getState().downloadMeta[modelFile]?.url
  const parsed = origin ? parseHfUrl(origin) : null
  if (!parsed) return Promise.resolve(null)
  const answer = resolveHfGgufFiles(`${parsed.user}/${parsed.repo}`, extractGgufQuant(modelFile))
    .then((resolution) => resolution?.imagePart ?? null)
    .catch(() => null)
  asked.set(modelFile, answer)
  return answer
}

/** Test-only: forget which repositories were asked. */
export function __resetImagePartSources(): void {
  asked.clear()
}

/** Parts whose arrival is already being waited for, by part file name. */
const waiting = new Set<string>()

/**
 * Fetch the image part of the installed model at `modelPath`.
 *
 * Resolves once the download has STARTED; the download list shows it from
 * there. When it finishes, every model list is refreshed, and a model that is
 * loaded right now is loaded again with its part. Throws when no source is
 * known or the start is refused, with a sentence the caller can show.
 */
export async function addImagePart(modelPath: string, label?: string): Promise<void> {
  const modelFile = fileNameOf(modelPath)
  const source = await findImagePartSource(modelFile)
  if (!source) throw new Error('No image part is known for this model.')
  const partFile = imagePartFileName(modelFile)
  await startPlannedDownload(
    [{ url: source.url, filename: partFile, expectedBytes: source.sizeBytes, sha256: source.sha256 }],
    folderOf(modelPath),
    label ?? modelFile,
  )
  watchForArrival(partFile, modelPath)
}

/**
 * When the part has landed: tell the lists, and let a loaded model see.
 *
 * A subscription on the download store, which the poller refills once a
 * second anyway, and it ends on every outcome: complete, failed, or cancelled
 * (the row is gone).
 */
function watchForArrival(partFile: string, modelPath: string): void {
  if (waiting.has(partFile)) return
  waiting.add(partFile)
  let seen = false
  const look = () => {
    const row = useDownloadStore.getState().downloads[partFile]
    if (!row) {
      if (seen) stop()
      return
    }
    seen = true
    if (row.status === 'error') stop()
    else if (row.status === 'complete') {
      stop()
      void partArrived(modelPath)
    }
  }
  const unsubscribe = useDownloadStore.subscribe(look)
  function stop() {
    waiting.delete(partFile)
    unsubscribe()
  }
  look()
}

async function partArrived(modelPath: string): Promise<void> {
  window.dispatchEvent(new CustomEvent('lu-models-refresh'))
  try {
    const status = await bundledEngineStatus()
    if (!status?.running || !sameFile(status.model_path, modelPath)) return
    // The loaded model was started without the part. Loading it again is what
    // makes it see, and it waits until no answer is being written: a restart
    // under a running answer would cut the answer off.
    whenRunsIdle(() => {
      void swapBundledModel(modelPath)
        .then(() => window.dispatchEvent(new CustomEvent('lu-models-refresh')))
        .catch((err) => log.warn('[image-part] the model could not be loaded again with its image part', { err }))
    })
  } catch (err) {
    log.warn('[image-part] could not ask the engine after the image part arrived', { err })
  }
}

function sameFile(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}
