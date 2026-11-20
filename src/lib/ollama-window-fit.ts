/**
 * What can honestly be said about a context window that is too large for
 * this machine, and the sentences that say it.
 *
 * Only what was MEASURED is said. After a load Ollama reports for every model
 * how many bytes it takes with its window and how many of them sit in
 * graphics memory (/api/ps: `size` and `size_vram`). The difference runs on
 * the CPU. That is a fact about this model with this window on this machine.
 *
 * Nothing is predicted before a load, on purpose. The memory a window needs
 * follows from the model's layers and heads only for a plain transformer;
 * models with sliding window attention or with layers that keep no cache take
 * a fraction of that. Measured on 10.10.2026 on a 48 GB Mac: a 27B at 32768
 * tokens took about 1.5 GB on top of its file, where the plain formula says
 * many times more. A warning from that formula would be wrong for exactly
 * the models people load today, and free memory is not read at all. The
 * honest order is: load, read back, say what happened.
 *
 * Pure, so every sentence can be tested without a machine.
 */

/** What /api/ps reports about one loaded model, as far as this file needs it. */
export interface LoadedSizes {
  /** Bytes the loaded model takes in total, weights and context together. */
  size: number
  /** How many of those bytes sit in graphics memory. */
  sizeVram: number
}

/**
 * The share of a loaded model that runs on the CPU, in whole percent, or null
 * when /api/ps did not report the sizes.
 */
export function cpuSharePercent(loaded: LoadedSizes): number | null {
  if (!(loaded.size > 0) || !(loaded.sizeVram >= 0)) return null
  const onCard = Math.min(loaded.sizeVram, loaded.size)
  const share = Math.round(((loaded.size - onCard) / loaded.size) * 100)
  // A sliver that rounds to nothing is still not "all of it on the card",
  // and one that rounds to everything is still not "none of it".
  if (share === 0 && onCard < loaded.size) return 1
  if (share === 100 && onCard > 0) return 99
  return share
}

function gigabytes(bytes: number): string {
  const gb = bytes / 1_073_741_824
  return gb >= 10 ? `${Math.round(gb)} GB` : `${Math.round(gb * 10) / 10} GB`
}

/**
 * The sentence about a model that is loaded right now, for the place where
 * the window is set. Null when all of it sits in graphics memory or nothing
 * is known.
 */
export function loadedOnCpuSentence(loaded: LoadedSizes | null | undefined): string | null {
  if (!loaded) return null
  const share = cpuSharePercent(loaded)
  if (share === null || share <= 0) return null
  if (share >= 100) return `Loaded now with this window: ${gigabytes(loaded.size)}, all of it on the CPU.`
  return `Loaded now with this window: ${gigabytes(loaded.size)}, ${share}% of it on the CPU, so answers are slower. A smaller context window needs less memory.`
}

/** The short form for a row of the model picker. Null under the same conditions. */
export function loadedOnCpuLabel(loaded: LoadedSizes | null | undefined): string | null {
  if (!loaded) return null
  const share = cpuSharePercent(loaded)
  if (share === null || share <= 0) return null
  return share >= 100 ? 'on the CPU' : `${share}% on the CPU`
}

/** The tooltip that goes with the short form. */
export function loadedOnCpuTitle(loaded: LoadedSizes | null | undefined): string | null {
  const label = loadedOnCpuLabel(loaded)
  if (!label || !loaded) return null
  return `Ollama reports ${gigabytes(loaded.size)} for this model as it is loaded now, and ${gigabytes(Math.min(loaded.sizeVram, loaded.size))} of that in graphics memory. The rest runs on the CPU, which is slower. A smaller context window needs less memory.`
}
