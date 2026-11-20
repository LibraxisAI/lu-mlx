/**
 * A waiting line that counts its seconds: "<what is happening> 12s".
 *
 * Long silent stretches are normal in a local run (a sampling step on a full
 * card, a VAE decode, a prompt rewrite by a 9B model), and a line that does
 * not move reads as a hang. So the line repaints every second, whatever the
 * work behind it reports. One counter for every waiting line: the render's
 * phases use it, and so does "Improving your prompt…", which stood still for
 * 175 s on the test box (03.10.2026) because it was the one line without it.
 */
export interface ElapsedLine {
  /** Change what is happening. Repaints at once, the count keeps running. */
  setLabel: (label: string) => void
  /** Stop repainting. The last line stays where the caller painted it. */
  stop: () => void
}

export function elapsedLine(paint: (line: string) => void, label: string): ElapsedLine {
  const startedAt = Date.now()
  let current = label
  const repaint = () => paint(`${current} ${Math.round((Date.now() - startedAt) / 1000)}s`)
  repaint()
  const ticker = setInterval(repaint, 1000)
  return {
    setLabel: (next) => { current = next; repaint() },
    stop: () => clearInterval(ticker),
  }
}
