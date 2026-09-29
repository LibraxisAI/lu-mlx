import type { ComfyApiGraph } from '../types/comfy-graph'

/**
 * Local upscale graph: LoadImage → ImageScale → SaveImage.
 *
 * The cloud upscale lane used to be WaveSpeed-only. ImageScale is a core
 * ComfyUI node (lanczos, crop disabled), so a connected ComfyUI — including
 * the user's already-running instance on this Mac — can do the same job
 * without a checkpoint. Width/height come from the Create size knobs.
 */
export function buildLocalUpscaleWorkflow(
  imageFilename: string,
  width: number,
  height: number,
): ComfyApiGraph {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  return {
    '1': {
      class_type: 'LoadImage',
      inputs: { image: imageFilename },
    },
    '2': {
      class_type: 'ImageScale',
      inputs: {
        image: ['1', 0],
        upscale_method: 'lanczos',
        width: w,
        height: h,
        crop: 'disabled',
      },
    },
    '3': {
      class_type: 'SaveImage',
      inputs: {
        images: ['2', 0],
        filename_prefix: 'LU_upscale',
      },
    },
  }
}
