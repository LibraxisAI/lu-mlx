// The prompt a result was made from, for the views that show it.
//
// Every run writes its prompt into the gallery entry (local engine, the Mac's
// own engine, the cloud, an order from the chat). Two kinds of entry carry
// none, and for those this says so instead of showing a text nobody wrote:
//
// - a tool that takes no prompt (cutout, enhance, erase, a talking character,
//   motion control). The views of these lanes have no prompt field.
// - an entry from before 3.0.6 whose `prompt` holds the name of the run
//   ("Background removed"). The cloud start used to write the name there so
//   the tile had a title; the title lives in `label` now.
import type { GalleryItem } from '../../stores/createStore'

const NO_PROMPT_INTENTS: ReadonlySet<string> = new Set(['removebg', 'upscale', 'eraser', 'lipsync', 'motion'])

export function ranPrompt(item: Pick<GalleryItem, 'prompt'> & Partial<Pick<GalleryItem, 'label' | 'intent' | 'type'>>): string {
  const prompt = item.prompt?.trim() ?? ''
  if (!prompt) return ''
  // A voice line is the one result of the lip sync lane that has a text: what
  // the voice says.
  if (item.type !== 'audio' && item.intent && NO_PROMPT_INTENTS.has(item.intent)) return ''
  if (prompt === item.label?.trim()) return ''
  return prompt
}

/** Is there anything the prompt panel would show for this result? */
export function hasPromptPanel(item: Parameters<typeof ranPrompt>[0] & Partial<Pick<GalleryItem, 'promptOriginal' | 'improveFailed'>>): boolean {
  return !!(ranPrompt(item) || item.promptOriginal || item.improveFailed)
}
