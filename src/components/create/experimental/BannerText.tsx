import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** The text inside the red bar of the Create surface: readable, selectable,
 *  copyable.
 *
 *  It used to be one `truncate`d line. A training run that dies prints a
 *  Python traceback, and one line of it cut at the window edge is what reached
 *  us as "the error is cut off and I cannot copy it" (GitHub #121;,
 *  2026-09-04, who read the same bar at full window width). The bar keeps its
 *  height in check by scrolling instead of cutting, and the button puts the
 *  whole message on the clipboard for the bug report.
 *
 *  The same treatment the setup note under the Character Studio buttons got in
 *  d5f5b32; this is the second surface, the one a failed RUN lands on. */
export function BannerText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* A refused clipboard is not worth a second error line. */ }
  }
  return (
    <span className="flex items-start gap-2 min-w-0">
      <span
        data-testid="create-error-text"
        tabIndex={0}
        className="flex-1 min-w-0 max-h-40 overflow-y-auto select-text whitespace-pre-wrap break-words"
      >
        {text}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy error"
        title="Copy the whole message"
        className="shrink-0 flex items-center gap-1 opacity-70 hover:opacity-100 transition-opacity"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}
