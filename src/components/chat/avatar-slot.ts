/**
 * The avatar column of a conversation, one recipe for chat and code view.
 *
 * The user has a chip: a framed square with their picture or a small figure.
 * The model has none. Its sign is the LU mark, bare, at the size of the mark
 * that shows while it works (GRID in status/glyph-geometry.ts, 20 px), so the
 * line that says "Working" and the answers above it read as one speaker. The
 * grey chip behind the mark made it look like a second user.
 *
 * Both slots are 24 px wide, so the text of both speakers starts on one edge.
 */

/** The place of either speaker: 24 px, its content in the middle. */
const PLACE = 'w-6 h-6 flex items-center justify-center shrink-0'

/** The chip of the user. */
export const AVATAR_SLOT = `${PLACE} rounded-md overflow-hidden bg-gray-100 dark:bg-white/8 border border-gray-200 dark:border-white/10`

/** The place of the model's mark: the width of the chip, no surface, no frame. */
export const MODEL_MARK_SLOT = PLACE

/** The mark itself, 20 px like the working mark. */
export const MODEL_MARK = 'w-5 h-5 object-contain opacity-90'
