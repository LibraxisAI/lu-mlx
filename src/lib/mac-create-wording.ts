// What Create says on a Mac when a local run cannot start.
//
// The sentences in hooks/useCreate.ts were written for ComfyUI: "Add
// checkpoints or FLUX models to ComfyUI.", "Install Wan 2.1 or AnimateDiff
// models.", "Checking ComfyUI...". A Mac has no ComfyUI and never starts one
// (its local media is MLX, in the app's own process), so each of them named a
// program the customer does not have (persona walk, 09.10.2026, Fund 12).
// Since Fund 2 the Create button no longer leads there, but the agent and a
// stale stored pick still can.

/** No model of this lane is installed. Where to get one is the Model Manager. */
export function macNoModelLine(mode: 'image' | 'video'): string {
  return mode === 'image'
    ? 'No image model is installed on this Mac yet. Get one in Models, under Image.'
    : 'No video model is installed on this Mac yet. Get one in Models, under Video.'
}

/**
 * The line for a local run a Mac has no lane for. Everything past the two MLX
 * branches of `generate` is a ComfyUI graph: with models installed the tool
 * itself is what does not run here, without them the lane is simply empty.
 */
export function macNoLocalLaneLine(mode: 'image' | 'video', laneHasModels: boolean): string {
  return laneHasModels
    ? 'This tool does not run locally on a Mac. Turn on Cloud to use it.'
    : macNoModelLine(mode)
}
