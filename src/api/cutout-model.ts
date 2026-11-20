// The model behind Cutout (Remove Background), and whether it is on the drive.
//
// The ComfyUI-RMBG node fetches its model itself, inside the first run, and
// says nothing while it does. On the box (04.10.2026) that was 160 seconds of
// "Queued... Ns" for an 885 MB file the card had announced as "~300 MB".
// One place for the name, the size and the question, so the setup card, the
// waiting line and the result footer cannot disagree again.

import { backendCall } from './backend'
import { comfyModelTarget } from './discover'
import { apiNodes, type ComfyApiGraph } from '../types/comfy-graph'

interface CutoutModelFile {
  /** Folder under ComfyUI's models directory, and the file inside it. */
  subfolder: string
  file: string
  bytes: number
}

/** Measured: models\RMBG\RMBG-2.0\model.safetensors, 884 878 856 bytes
 *  (04.10.2026, the box). Only models with a measured size are listed; for
 *  any other the app says nothing about a download it cannot size. */
const CUTOUT_MODEL_FILES: Record<string, CutoutModelFile> = {
  'RMBG-2.0': { subfolder: 'RMBG', file: 'RMBG-2.0/model.safetensors', bytes: 884_878_856 },
}

/** The model the node picks when nobody chooses: the one the setup card names. */
export const DEFAULT_CUTOUT_MODEL = 'RMBG-2.0'

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`

/** "885 MB", for the setup card. */
export const DEFAULT_CUTOUT_MODEL_SIZE = megabytes(CUTOUT_MODEL_FILES[DEFAULT_CUTOUT_MODEL].bytes)

/** The model a cutout graph runs on: the RMBG node's own `model` widget. */
export function cutoutModelOf(workflow: ComfyApiGraph): string | undefined {
  for (const [, node] of apiNodes(workflow)) {
    if (node.class_type !== 'RMBG') continue
    const model = node.inputs?.model
    return typeof model === 'string' && model ? model : undefined
  }
  return undefined
}

/**
 * The line for the wait while the node fetches its model, or null when the
 * model is on the drive, is one the app has no size for, or cannot be looked
 * at from here (a ComfyUI on another machine, a backend that does not answer).
 */
export async function cutoutDownloadLine(model: string | undefined): Promise<string | null> {
  const known = model ? CUTOUT_MODEL_FILES[model] : undefined
  if (!known) return null
  try {
    if ((await comfyModelTarget()).remote) return null
    const [found] = await backendCall<Array<{ exists: boolean; complete: boolean }>>('check_model_sizes', {
      files: [{ subfolder: known.subfolder, filename: known.file, expectedBytes: known.bytes }],
    })
    if (!found || (found.exists && found.complete)) return null
    return `Downloading the cutout model (${megabytes(known.bytes)}), first run only...`
  } catch {
    return null
  }
}
