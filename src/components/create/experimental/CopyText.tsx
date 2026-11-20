import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** Puts `text` on the clipboard and says so for two seconds. */
export function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No clipboard here (a refused permission): the text stays selectable.
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void copy() }}
      aria-label={label}
      title={label}
      className="t-control flex shrink-0 items-center gap-1 text-gray-400 transition-colors hover:text-gray-900 dark:hover:text-gray-100"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
