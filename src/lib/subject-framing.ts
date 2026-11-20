// ─── A full figure needs a tall frame ───
//
// GH #142 (Windows 11, chat image generation): "full body" came out as a
// close-up nine times in ten, whatever the prompt or negative prompt said.
// The chat's image tool rendered every picture as the model's square default
// (1024 x 1024, 512 x 512 for SD 1.5), and the SDXL, Pony and Illustrious
// families were trained mostly on portraits: asked for a whole person in a
// square, they crop to the face. The chat model almost never passes a size of
// its own. So when the prompt asks for a whole figure and nobody named a size,
// the picture gets the portrait frame those models were trained on.

const FULL_FIGURE = /\b(?:full[\s-]?body|whole[\s-]body|entire[\s-]body|full[\s-]figure|full[\s-]length|full[\s-]shot|long[\s-]shot|head[\s-]to[\s-](?:toes?|feet|foot))\b/i

/** Does the prompt ask for the whole figure in frame? */
export function wantsFullFigure(prompt: string): boolean {
  return FULL_FIGURE.test(prompt)
}

/**
 * The 2:3 portrait frame for a model whose square default is `square` px.
 * The trained buckets where there is one (SD 1.5, SDXL / FLUX / Z-Image,
 * Qwen-Image's own 2:3 preset), else the same pixel count at 2:3.
 */
export function portraitFrame(square: number): { width: number; height: number } {
  if (square <= 576) return { width: 512, height: 768 }
  if (square <= 1100) return { width: 832, height: 1216 }
  if (square <= 1400) return { width: 1056, height: 1584 }
  const snap = (n: number) => Math.round(n / 64) * 64
  return { width: snap(square * Math.sqrt(2 / 3)), height: snap(square * Math.sqrt(3 / 2)) }
}
