// The Mac has two video engines. `mlx-video` runs Wan and LTX at full size and
// has a setup step of its own. `ltx-2-mlx` runs the LTX packs that are
// quantized already, lives in a venv of its own, and arrives with the first
// model that needs it (`ltx2mlx` in src-tauri/src/commands/video.rs).
//
// Kept apart from `api/mlx-video`, which the tests replace as a whole.

/** The family of the quantized LTX packs, `ltx2mlx::FAMILY` in video.rs. */
export const QUANTIZED_LTX_FAMILY = 'ltx_2q'

/**
 * Whether a model of this family brings its engine along. Such a model needs
 * no engine set up beforehand: its own install does that, in the same slot.
 */
export function videoModelBringsItsEngine(family: string | undefined): boolean {
  return family === QUANTIZED_LTX_FAMILY
}

/**
 * Whether any video engine is set up. Which one a model needs is the
 * backend's to say: it lists a model as installed only with its engine.
 */
export function anyVideoEngineReady(
  status: { mlxInstalled?: boolean; ltx2MlxInstalled?: boolean } | null | undefined,
): boolean {
  return !!status && (!!status.mlxInstalled || !!status.ltx2MlxInstalled)
}
