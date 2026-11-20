// Whether a Mac media model sits in the memory this Mac has.
//
// One rule for the tile of the Model Manager, its "Fits my Mac" filter, the
// starter the setup of Create takes, and the line Create shows before a run.
// A Mac sold as 16 GB reports 17,179,869,184 bytes and less than that through
// some probes, so the installed size is rounded to whole GB before it is held
// against what the catalogue names.

/** The memory a tile and a filter hold a model against: what the catalogue
 *  recommends, where it names that apart from the least a run is let through
 *  with (`recommended_ram_gb` in src-tauri/src/commands/video.rs). */
export function memoryNeedGb(model: { minRamGB: number; recommendedRamGB?: number }): number {
  return model.recommendedRamGB ?? model.minRamGB
}

/** True or false, or null when one of the two numbers is not known. */
export function fitsMacMemory(needGb: number, memoryGb: number | null | undefined): boolean | null {
  if (!memoryGb || !needGb) return null
  return Math.round(memoryGb) >= needGb
}
