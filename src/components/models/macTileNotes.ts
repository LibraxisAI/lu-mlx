// What a Mac media tile must say about a model even when its description is
// cut off.
//
// A tile shows two lines of the catalogue's description. The sentences that
// end a description are the ones a customer has to see before a download of
// 17 GB: "Experimental: not yet tested in LU.", "Research license,
// non-commercial use only.", "Its repository asks for a free Hugging Face
// token." They were exactly what the two lines cut off, and stood in the
// tooltip alone (persona walk of the Mac app, 09.10.2026, Fund 16).
//
// So each of them is a mark on the tile, and the two lines are spent on what
// the model is. The catalogue lives in Rust (commands/mlx.rs, image_mflux.rs,
// video.rs) and writes these sentences word for word; a test reads all three
// files and turns red on a sentence about a licence or a token that no mark
// knows.

export interface TileNote {
  id: 'experimental' | 'non-commercial' | 'hf-token'
  /** The word on the tile. */
  label: string
  /** The catalogue's sentence, which is the tooltip of the mark. */
  sentence: string
}

export const TILE_NOTES: readonly TileNote[] = [
  { id: 'non-commercial', label: 'Non-commercial', sentence: 'Research license, non-commercial use only.' },
  { id: 'hf-token', label: 'Needs a Hugging Face token', sentence: 'Its repository asks for a free Hugging Face token.' },
  { id: 'experimental', label: 'Experimental', sentence: 'Experimental: not yet tested in LU.' },
]

/** A description taken apart: the marks it carries, and the text without
 *  their sentences. */
export function splitTileNotes(description: string): { text: string; notes: TileNote[] } {
  let text = description
  const notes: TileNote[] = []
  for (const note of TILE_NOTES) {
    if (!text.includes(note.sentence)) continue
    notes.push(note)
    text = text.replace(note.sentence, '')
  }
  return { text: text.replace(/\s+/g, ' ').trim(), notes }
}
