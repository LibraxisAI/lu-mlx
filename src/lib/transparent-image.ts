// Transparent PNGs from local Qwen-Image 2.1.
//
// Read off the real sources on 2026-10-02, not guessed:
//   - Comfy-Org/workflow_templates, templates/image_qwen_image_2_1_t2i.json,
//     the note "Transparent Image": wrap the prompt as written below and save
//     as PNG to keep the alpha channel.
//   - ComfyUI 0.38 comfy/sd.py: the Qwen-Image 2.1 VAE (decoder.head.2.weight
//     with 4 output channels, temporal kernel 1) sets output_channels to 4, so
//     VAEDecode returns an RGBA image. The official qwen_image_2.1_vae_bf16
//     file has exactly that head (safetensors header: [4, 144, 1, 3, 3]).
//   - ComfyUI nodes.py SaveImage: Image.fromarray on the 4 channel array writes
//     an RGBA PNG. No extra node is needed, the existing SaveImage keeps alpha.
// So the whole feature is the prompt wrapper: the graph is the one the model
// already runs.

/** Model families that can write an alpha channel. */
const TRANSPARENT_FAMILIES: ReadonlySet<string> = new Set(['qwenimage'])

/** Does this model family offer "Transparent background"? Qwen-Image 2.1 only:
 *  Qwen-Image 1 and every other family decode three channels. */
export function supportsTransparent(modelType: string | undefined | null): boolean {
  return !!modelType && TRANSPARENT_FAMILIES.has(modelType)
}

/** The prompt wrapper the official template documents. A trailing full stop of
 *  the user's own description is dropped so the sentence does not read "..". */
export function transparentPrompt(prompt: string): string {
  const description = prompt.trim().replace(/[.\s]+$/, '')
  return `This is an RGBA format image with transparency. ${description}. The image has an alpha channel and a transparent background.`
}

/** Does this gallery entry carry see-through pixels? A cutout from Remove
 *  Background and a transparent Qwen-Image 2.1 render both do, and both sit on
 *  a checkerboard instead of solid black. */
export function itemHasAlpha(item: { intent?: string; transparent?: boolean }): boolean {
  return item.intent === 'removebg' || item.transparent === true
}

/** Does this run ask for a transparent picture? Only a local text-to-image
 *  run on a family that can write alpha: an edit, a specialized lane and every
 *  other family ignore the switch. */
export function wantsTransparent(run: {
  enabled: boolean
  intent: string
  isImageToImage: boolean
  isSpecializedLane: boolean
  modelType: string | undefined | null
}): boolean {
  return run.enabled && run.intent === 'image' && !run.isImageToImage && !run.isSpecializedLane && supportsTransparent(run.modelType)
}
