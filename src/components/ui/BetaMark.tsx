import { BETA_LABEL, betaNote, type BetaFeature } from '../../lib/beta'

/**
 * The one Beta mark of the app: the word in a hairline frame, grey and
 * bright, no colour (index.css, .lu-beta). Hovering it says what Beta means
 * for this feature. Draws nothing for a feature that has left the list in
 * lib/beta.ts.
 */
export function BetaMark({ feature, className }: { feature: BetaFeature; className?: string }) {
  const note = betaNote(feature)
  if (!note) return null
  return (
    <span className={`lu-beta${className ? ` ${className}` : ''}`} title={note} data-beta={feature}>
      {BETA_LABEL}
    </span>
  )
}
