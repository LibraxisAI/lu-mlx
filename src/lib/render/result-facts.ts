// The line under a finished result: what it is, in the few facts that are true
// of it.
//
// The box, 04.10.2026: a cutout read "512×512 · seed 697334996 · sd turbo".
// A cutout has no seed and never touched sd turbo; the line repeated the Image
// tab's picker. A tool that runs without the picker's model (Cutout, Enhance,
// Erase) says its size and, where it is known, the model the tool itself ran
// on, nothing else.
import type { GalleryItem } from '../../stores/createStore'

/** Runs that take no seed and no model from the picker. */
const TOOL_INTENTS: ReadonlySet<string> = new Set(['removebg', 'upscale', 'eraser'])

function prettyModel(file: string): string {
  return file.replace(/\.(safetensors|ckpt|pt)$/i, '').replace(/[_]+/g, ' ')
}

export function resultFacts(item: GalleryItem): string[] {
  if (item.type === 'audio') return [prettyModel(item.model)]
  const size = `${item.width}×${item.height}`
  if (item.intent && TOOL_INTENTS.has(item.intent)) {
    return item.toolModel ? [size, item.toolModel] : [size]
  }
  return [size, `seed ${item.seed}`, prettyModel(item.model)]
}
