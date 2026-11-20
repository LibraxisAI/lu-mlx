/**
 * R5-4, R5-5, R5-6: ContentPolicySettings.tsx had drifted from the Web
 * wording in three spots: the "strict" and "off" hints (R5-5, R5-6) and the
 * footnote about what the setting covers (R5-4). One wording is better than
 * two for the two hints that mean the same thing on both sides; the footnote
 * differs on purpose, since Desktop also renders locally and Web does not.
 *
 * This reads the SOURCE of both files rather than importing Web's component
 * (which is a Next.js file the desktop bundle cannot import), matching the
 * fixliste's "string comparison" test shape.
 *
 * Deliberately does NOT check this file against PUBLIC_FILTER_WORDS: that
 * guard belongs to the public marketing site on the payment domain
 * (locallyuncensored.com), not to this signed-in-only account setting. The
 * word "filter" stays allowed here.
 *
 * B5 (review-w2ui.md, 18.09.2026): this used to read Web's source through a
 * fixed six-`..` `__dirname` path, which only resolves from
 * `lu-301-wt/<name>/`. Outside that (the main checkout, Windows, CI) the
 * `readFileSync` at module scope threw and took the whole file down. Same
 * fix as `katalog-paritaet-web.test.ts`: only LU_WEB_REPO says where the web
 * checkout is (web-checkout.ts). Not set, the guard is skipped with a line on
 * stderr. Set to something that is not a web checkout, it fails.
 *
 * Run: LU_WEB_REPO=/path/to/web npx vitest run \
 *   src/components/settings/__tests__/content-policy-wording-parity.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webCheckout } from '../../../lib/__tests__/web-checkout'

const DESKTOP_SRC = readFileSync(resolve(__dirname, '../ContentPolicySettings.tsx'), 'utf8')

const REL_PATH = 'apps/web/components/settings/ContentPolicySettings.tsx'
const WEB = webCheckout('content-policy-wording-parity', [REL_PATH])
const WEB_SRC = WEB ? readFileSync(resolve(WEB, REL_PATH), 'utf8') : ''

describe.skipIf(!WEB)('R5-5, R5-6: the strict and off hints match Web word for word', () => {
  it('the "strict" hint is identical', () => {
    const hint = "The strictest setting we have. Choose this if others use your screen."
    expect(DESKTOP_SRC).toContain(hint)
    expect(WEB_SRC).toContain(hint)
  })

  it('the "off" hint (both branches) is identical', () => {
    for (const hint of [
      'Only the legal limits below apply. Requires an age confirmation.',
      'Only the legal limits below apply.',
    ]) {
      expect(DESKTOP_SRC).toContain(hint)
      expect(WEB_SRC).toContain(hint)
    }
  })

  it('NEGATIVE CONTROL: the old, drifted wording is gone from Desktop', () => {
    expect(DESKTOP_SRC).not.toContain('The tightest filter we have')
    expect(DESKTOP_SRC).not.toContain('No filter beyond the legal limits below')
  })

  it('does not police this settings file against the marketing site word list', () => {
    // PUBLIC_FILTER_WORDS is a public-copy guard for the payment domain. This
    // file is a signed-in account setting, not public marketing copy, and
    // "filter" (as in "Standard filter") is fine to use here.
    expect(DESKTOP_SRC).toMatch(/filter/i)
  })
})

describe.skipIf(!WEB)('R5-4: the footnote keeps Web wording for its first two sentences', () => {
  const sharedPrefix = 'Applies to images and video generated in the cloud. Text is unaffected.'

  it('Desktop carries the shared prefix plus its own local-machine sentence', () => {
    expect(DESKTOP_SRC).toContain(sharedPrefix)
    // The JSX text wraps across two source lines; normalise whitespace before
    // comparing so the test does not depend on exactly where the wrap falls.
    expect(DESKTOP_SRC.replace(/\s+/g, ' ')).toContain('Nothing on your own machine is affected.')
  })

  it('Web carries the same shared prefix', () => {
    expect(WEB_SRC).toContain(sharedPrefix)
  })

  it('NEGATIVE CONTROL: the Desktop-only sentence does not appear in Web', () => {
    // Web has no local backend at all, so this addition is Desktop-specific
    // and must stay that way.
    expect(WEB_SRC).not.toContain('Nothing on your own machine is affected')
    expect(WEB_SRC).not.toContain('own machine')
  })

  it('NEGATIVE CONTROL: the old, drifted footnote wording is gone from Desktop', () => {
    expect(DESKTOP_SRC).not.toContain('rendered in the cloud')
    expect(DESKTOP_SRC.replace(/\s+/g, ' ')).not.toContain('and nothing on your own machine is.')
  })
})
