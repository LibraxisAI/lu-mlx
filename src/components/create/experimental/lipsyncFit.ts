import { getLipsyncBundles } from '../../../api/model-bundles'
import { vramFit, vramFitLine, vramNeedTitle } from '../../../lib/vram-fit'

/** The talking character card's word on the graphics card: the verdict of the
 *  bundle the button installs, in the words its Model Manager card uses. One
 *  source, so the two cannot disagree (the box, 03.10.2026: "Comfortable on
 *  12 GB VRAM" on the stage, "Tight on your 12 GB card" on the card). Without
 *  a detected card it states what the bundle needs instead. */
export function lipsyncFitLine(cardGb: number | null): string {
  const b = getLipsyncBundles()[0]
  if (!b) return ''
  const line = vramFitLine(vramFit(b, cardGb), cardGb)
  if (line) return ` ${line}.`
  const need = vramNeedTitle(b)
  return need ? ` ${need}` : ''
}
