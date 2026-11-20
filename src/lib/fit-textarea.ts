// ─── Grow a textarea to its text without laying out the page around it ───
//
// GH #139 (3.0.2, Linux AppImage, 3440x1440): typing in the composer lagged
// about a second per key once a chat held a dozen messages, and the lag grew
// with the visible part of the conversation, not with the text. Every key ran
// the usual auto-grow on the live field: height 'auto', read scrollHeight, set
// the height back. The first write collapses the field to one row, so the
// column it shares with the transcript has to be laid out again before
// scrollHeight can answer, and the second write undoes it. That is two layouts
// of the whole transcript per key, and on WebKitGTK a repaint of the masked
// message list at full window size.
//
// The text is now measured on a copy that lives outside the page: a hidden,
// fixed textarea in its own closed shadow root, so neither page CSS nor a
// `querySelector('textarea')` ever reaches it. Closed, because Playwright and
// CDP tools look into open shadow roots: with an open one, a spec's
// `locator('textarea').first()` picked the hidden copy and could not type
// (e2e/cloud-create.spec.ts, 28.09.2026). The real field's height is
// written only when the answer differs from what it already has, which within
// a line it never does. Typing then touches nothing outside the field.

/** Everything that decides where a textarea wraps and how tall its lines are. */
const TEXT_LAYOUT = [
  'box-sizing', 'width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-variation-settings', 'font-kerning',
  'letter-spacing', 'word-spacing', 'line-height', 'text-transform', 'text-indent', 'tab-size',
  'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'direction', 'text-rendering',
]

let mirror: HTMLTextAreaElement | null = null

function measuringCopy(): HTMLTextAreaElement {
  if (mirror?.isConnected) return mirror
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.setAttribute('data-lu-textarea-mirror', '')
  // Out of flow, zero-sized and contained: writing into the copy lays out the
  // copy and nothing else.
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict'
  const copy = document.createElement('textarea')
  copy.tabIndex = -1
  copy.readOnly = true
  // Solid borders so the copied widths count; overflow hidden so no scrollbar
  // narrows the line the way the field's own never does once it fits.
  copy.style.cssText = 'display:block;margin:0;border-style:solid;appearance:none;overflow:hidden;resize:none;height:auto;min-height:0;max-height:none'
  host.attachShadow({ mode: 'closed' }).appendChild(copy)
  document.body.appendChild(host)
  mirror = copy
  return copy
}

/**
 * Size `el` to its text, capped at `maxPx`. Same answer as the old
 * `height = 'auto'; height = min(scrollHeight, max)`, without ever resizing
 * the live field on the way there.
 */
export function fitTextarea(el: HTMLTextAreaElement, maxPx = Infinity): void {
  const style = getComputedStyle(el)
  // Not laid out (display: none, or not in the page yet): keep what it has.
  if (!(parseFloat(style.width) > 0)) return
  const copy = measuringCopy()
  for (const prop of TEXT_LAYOUT) {
    const value = style.getPropertyValue(prop)
    if (copy.style.getPropertyValue(prop) !== value) copy.style.setProperty(prop, value)
  }
  if (copy.rows !== el.rows) copy.rows = el.rows
  if (copy.placeholder !== el.placeholder) copy.placeholder = el.placeholder
  copy.value = el.value
  const next = `${Math.min(copy.scrollHeight, maxPx)}px`
  if (el.style.height !== next) el.style.height = next
}
