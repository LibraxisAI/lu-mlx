/**
 * Markdown that is still arriving, made presentable for the frame it is shown.
 *
 * Gegenprobe 01.10.2026: for a second the answer read "I created a file named `"
 * with a raw backtick, until the closing one arrived. An open inline code span
 * or an open bold run shows its marker as text until the model closes it.
 * While the answer streams, this closes them for display: the opened span
 * renders as what it will become, and an opener with nothing after it yet is
 * left out for that frame. The stored message is never touched; the finished
 * answer renders exactly what the model wrote.
 *
 * Fenced code needs nothing: an unclosed fence already renders as a code block
 * to the end, and nothing inside it is touched here.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The paragraph still being written, or null when it sits inside an open fence. */
function openParagraph(text: string): { head: string; tail: string } | null {
  const lines = text.split('\n')
  let fence: string | null = null
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i])
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) { fence = null; start = i + 1 }
      continue
    }
    if (m) { fence = m[1]; continue }
    if (!lines[i].trim()) start = i + 1
  }
  if (fence) return null
  const head = lines.slice(0, start).join('\n')
  return { head: start > 0 ? head + '\n' : '', tail: lines.slice(start).join('\n') }
}

function closeInlineCode(tail: string): string {
  const runs = tail.match(/`+/g) ?? []
  // Spans pair by equal run length; only the plain single backtick is ever
  // left open in practice, longer runs are rare enough to leave alone.
  const singles = runs.filter((r) => r === '`').length
  if (singles % 2 === 0) return tail
  if (tail.endsWith('`') && !tail.endsWith('``')) return tail.slice(0, -1)
  return tail + '`'
}

function closeBold(tail: string): string {
  // Code spans carry their own asterisks; they do not count.
  const outsideCode = tail.replace(/`[^`]*`/g, '')
  const runs = outsideCode.match(/\*\*/g) ?? []
  if (runs.length % 2 === 0) return tail
  if (tail.endsWith('**')) return tail.slice(0, -2)
  return tail + '**'
}

export function closeOpenMarkdown(text: string): string {
  const part = openParagraph(text)
  if (!part || !part.tail) return text
  return part.head + closeBold(closeInlineCode(part.tail))
}
