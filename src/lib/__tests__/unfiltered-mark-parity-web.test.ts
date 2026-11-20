/**
 * The words of the two model marks, desktop against web.
 *
 * 09.10.2026: the measured mark reads "No Filter" on both, word for
 * word, and so do both hover texts. The word of the second mark does NOT
 * match, on purpose: the app says "Uncensored", the web app on the payment
 * domain says a neutral word, and it lists the same models under neutral
 * names. This guard knows that one difference by name. Any other drift
 * between the two files fails it, and so does the day the two words become
 * the same without this file being told.
 *
 * Since 08.10.2026 the web app also names the open media models for the app
 * (`native_label` of the media catalogue), from one constant of its own. That
 * constant has to be this app's word.
 *
 * Without a web checkout next to this one the guard is skipped and says so.
 * A checkout from before the second mark existed is skipped the same way.
 *
 * Run: LU_WEB_REPO=/path/to/web npx vitest run src/lib/__tests__/unfiltered-mark-parity-web.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webCheckout } from './web-checkout'
import {
  STATEMENT_MARK_LABEL, STATEMENT_MARK_TITLE, UNFILTERED_MARK_LABEL, UNFILTERED_MARK_TITLE,
} from '../unfiltered-mark'

const REL_PATH = 'apps/web/lib/unfiltered-mark.ts'
const WEB = webCheckout('unfiltered-mark-parity-web', [REL_PATH])
const WEB_SRC = WEB ? readFileSync(resolve(WEB, REL_PATH), 'utf8') : ''

/** The value of an exported string constant, single- or double-quoted, on the
 *  declaration line or the one after it. */
function webConstant(name: string): string {
  const m = WEB_SRC.match(new RegExp(`export const ${name} =\\s*\\n?\\s*(['"])(.*)\\1`))
  if (!m) throw new Error(`${name} not found in ${REL_PATH}`)
  return m[2]
}

describe.skipIf(!WEB)('the model marks read the same on desktop and web, with one named difference', () => {
  it('the measured mark is the same word', () => {
    expect(webConstant('UNFILTERED_MARK_LABEL')).toBe(UNFILTERED_MARK_LABEL)
    expect(UNFILTERED_MARK_LABEL).toBe('No Filter')
  })

  it('both hover texts are identical', () => {
    expect(webConstant('UNFILTERED_MARK_TITLE')).toBe(UNFILTERED_MARK_TITLE)
    expect(webConstant('STATEMENT_MARK_TITLE')).toBe(STATEMENT_MARK_TITLE)
  })

  it('WANTED DIFFERENCE: the app names the second mark, the web app keeps a neutral word', () => {
    expect(STATEMENT_MARK_LABEL).toBe('Uncensored')
    const web = webConstant('STATEMENT_MARK_LABEL')
    expect(web).not.toBe(STATEMENT_MARK_LABEL)
    expect(web).not.toMatch(/uncensored/i)
  })

  it('and the web app hands the app its word back: the names it sends for the app are built from the same word', () => {
    // The chat list sends `native_name`, the media catalogue `native_label`.
    // The media names are derived on the web from one constant; it has to be
    // the word of this app, or the app would show a third wording.
    const file = resolve(WEB!, 'apps/web/lib/render/desktop-names.ts')
    expect(existsSync(file), 'apps/web/lib/render/desktop-names.ts').toBe(true)
    const m = readFileSync(file, 'utf8').match(/export const DESKTOP_MARK_LABEL = (['"])(.*)\1/)
    expect(m?.[2]).toBe(STATEMENT_MARK_LABEL)
  })

  it('and neither side still carries the old word as its mark', () => {
    for (const label of [UNFILTERED_MARK_LABEL, STATEMENT_MARK_LABEL, webConstant('UNFILTERED_MARK_LABEL'), webConstant('STATEMENT_MARK_LABEL')]) {
      expect(label).not.toMatch(/refusal/i)
    }
  })
})
