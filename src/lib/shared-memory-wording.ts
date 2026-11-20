/**
 * The chat catalogue, read on a machine with one memory pool (a Mac).
 *
 * The catalogue in api/discover.ts is written from a PC: "fits a 12 GB card",
 * "for high-VRAM setups", "Runs on your PC". An Apple Silicon Mac has no card
 * and no VRAM of its own; processor and graphics unit share one pool, and a
 * model takes its share of that pool. So the same numbers are said as memory
 * here, and as FREE memory: a model written up for a 12 GB card needs about
 * 12 GB that nothing else is using, which is not the same as a 12 GB Mac.
 *
 * Everything in this file is a rewrite at the point of display. With
 * `shared` false every function returns what it was given, so a PC reads the
 * catalogue exactly as before.
 *
 * NVFP4 and MXFP8: the catalogue itself now says what these Ollama tags are
 * (MLX builds for Apple Silicon, see the note in api/discover.ts), so they
 * need no rewrite here and read the same on every machine.
 */

import type { VramFit } from './vram-fit'

/**
 * The share of a Mac's memory one model can take. macOS does not hand the
 * whole pool to the graphics unit, and the system and the app live in the
 * same pool. 0.7 is an estimate, not a measurement: on 16 GB it leaves about
 * 11 GB, on 32 GB about 22 GB. It only moves the "runs on this Mac" hints;
 * no download is ever held back by it.
 */
export const SHARED_MEMORY_MODEL_SHARE = 0.7

/** The memory a chat model is compared with: the card on a PC, a share of the pool on a Mac. */
export function chatModelBudgetGb(shared: boolean, graphicsGb: number | null, ramGb: number | null): number | null {
  if (!shared) return graphicsGb
  const pool = ramGb ?? graphicsGb
  return pool ? Math.round(pool * SHARED_MEMORY_MODEL_SHARE) : null
}

// Order matters: the specific sentences go before the general words.
const REWRITES: ReadonlyArray<[RegExp, string]> = [
  [/\bfits an? (\d+) ?GB card\b/g, 'fits in $1 GB of free memory'],
  [/\bfits (\d+) ?GB (?:GPUs|VRAM)\b/gi, 'fits in $1 GB of free memory'],
  [/\bruns on an? (\d+) ?GB card\b/g, 'runs in $1 GB of free memory'],
  [/\bruns on (\d+) ?GB GPUs\b/g, 'runs in $1 GB of free memory'],
  [/\bon an? (\d+) ?GB card\b/g, 'in $1 GB of free memory'],
  [/\bon (\d+) ?GB cards\b/g, 'in $1 GB of free memory'],
  [/\b([Ff])or (\d+) ?GB(\+?) cards\b/g, '$1or $2 GB$3 of free memory'],
  [/\bfrom (\d+) ?GB VRAM\b/g, 'from $1 GB of free memory'],
  [/\b([Ff])or high-VRAM setups\b/g, '$1or Macs with a lot of memory'],
  [/\bHigh-VRAM setups\b/g, 'Macs with a lot of memory'],
  [/\bhigh-VRAM setups\b/g, 'Macs with a lot of memory'],
  [/\bbig VRAM only\b/g, 'a lot of memory only'],
  [/\blow VRAM quant\b/g, 'low memory quant'],
  [/\bVRAM\/RAM\b/g, 'memory'],
  [/\bRAM\/VRAM\b/g, 'memory'],
  [/\b(?:small|tiny) GPUs\b/g, 'Macs with little memory'],
  [/\bfor edge GPUs\b/g, 'for small machines'],
  [/\bVRAM\b/g, 'memory'],
]

/** A catalogue sentence as a Mac reads it. Unchanged where `shared` is false. */
export function sharedMemoryWording(text: string, shared: boolean): string {
  if (!shared || !text) return text
  return REWRITES.reduce((t, [from, to]) => t.replace(from, to), text)
}

/**
 * What is left of PC hardware in a sentence after the rewrite. The guard test
 * runs the whole catalogue through this, so a new entry that names a card in
 * a way the table above does not know turns the test red instead of reaching
 * a Mac. "model card" is a document, not hardware.
 */
export function pcHardwareLeft(text: string): string[] {
  const hits = text.match(/\b(?:\d+ ?GB cards?|graphics cards?|VRAM|RTX[ -]?\d*|Blackwell|H100|MI300X|datacenter GPUs|your PC|your GPU)\b/g)
  return hits ?? []
}

export interface FitWords { label: string; title: string }

const FIT_WORDS_SHARED: Record<VramFit, FitWords> = {
  fits: { label: 'Runs on this Mac', title: "Fits in this Mac's memory with room to spare. Fast." },
  tight: { label: 'Tight fit', title: 'Barely fits. With other apps open it can slow down.' },
  big: { label: 'Needs more memory', title: 'Bigger than the memory this Mac can give a model. It may load very slowly or not at all.' },
  unknown: { label: '', title: 'Memory not detected yet.' },
}

/** The verdict on a chat tile for a machine with one memory pool. */
export function sharedFitWords(fit: VramFit): FitWords {
  return FIT_WORDS_SHARED[fit]
}
