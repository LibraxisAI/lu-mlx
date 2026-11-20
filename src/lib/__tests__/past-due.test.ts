/**
 * A failed renewal as /api/me reports it (license.pastDue, license.pastDueTier,
 * web commit ee31e7f9), and the words the account panel puts on it.
 *
 * Two things can go wrong without anyone noticing: an older server that does
 * not send the fields is read as "payment failed", or the sentences drift away
 * from the ones the web account page shows for the very same account.
 *
 * Run: LU_WEB_REPO=/path/to/web npx vitest run src/lib/__tests__/past-due.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webCheckout } from './web-checkout'
import {
  PLAN_NAMES,
  PAST_DUE_ACTION,
  PAST_DUE_BADGE,
  PAST_DUE_WALLET_LINE,
  pastDueFromLicense,
  pastDueLine,
} from '../past-due'

describe('reading the fields off /api/me', () => {
  it('an older server that sends neither field means no failed payment', () => {
    expect(pastDueFromLicense({ status: 'none' })).toEqual({ pastDue: false, pastDueTier: null })
    expect(pastDueFromLicense({ status: 'active', tier: 'hosted' })).toEqual({ pastDue: false, pastDueTier: null })
    expect(pastDueFromLicense(undefined)).toEqual({ pastDue: false, pastDueTier: null })
  })

  it('pack credits keep the account active and the failed payment is still read', () => {
    expect(
      pastDueFromLicense({ status: 'active', tier: 'starter', pastDue: true, pastDueTier: 'hosted-pro' }),
    ).toEqual({ pastDue: true, pastDueTier: 'hosted-pro' })
  })

  it('an account without credits reads the same two fields', () => {
    expect(pastDueFromLicense({ status: 'none', pastDue: true, pastDueTier: null })).toEqual({
      pastDue: true,
      pastDueTier: null,
    })
  })

  it('only a literal true counts, and a tier without the flag is dropped', () => {
    const odd = { status: 'none', pastDue: 'yes', pastDueTier: 'hosted' } as unknown as Parameters<
      typeof pastDueFromLicense
    >[0]
    expect(pastDueFromLicense(odd)).toEqual({ pastDue: false, pastDueTier: null })
    expect(pastDueFromLicense({ status: 'active', pastDue: false, pastDueTier: 'hosted' })).toEqual({
      pastDue: false,
      pastDueTier: null,
    })
  })
})

describe('the sentence', () => {
  it('names the plan the way the web and the invoice name it', () => {
    expect(pastDueLine('hosted')).toBe(
      'The last payment for your Hosted plan failed, so the plan is paused. Pay the open invoice to bring it back.',
    )
    expect(pastDueLine('hosted-pro')).toContain('your Hosted Pro plan')
    expect(pastDueLine('hosted-max')).toContain('your Hosted Max plan')
  })

  it('says "your plan" when the plan is unknown', () => {
    for (const tier of [null, 'starter', 'something-new']) {
      expect(pastDueLine(tier)).toBe(
        'The last payment for your plan failed, so the plan is paused. Pay the open invoice to bring it back.',
      )
    }
  })
})

const REL_PATH = 'apps/web/lib/billing/past-due.ts'
const PRICING_PATH = 'apps/web/lib/pricing.ts'
const WEB = webCheckout('past-due', [REL_PATH, PRICING_PATH])
const WEB_FILE = WEB ? resolve(WEB, REL_PATH) : ''
const PRICING_FILE = WEB ? resolve(WEB, PRICING_PATH) : ''
const HAS_WEB = WEB !== undefined

describe.skipIf(!HAS_WEB)('the wording is the web wording', () => {
  const web = HAS_WEB ? readFileSync(WEB_FILE, 'utf8') : ''

  it('badge, button and wallet line are the same strings', () => {
    for (const text of [PAST_DUE_BADGE, PAST_DUE_ACTION, PAST_DUE_WALLET_LINE]) {
      expect(web).toContain(`'${text}'`)
    }
  })

  it('the sentence is built from the same template', () => {
    const [head, tail] = pastDueLine(null).split('your plan')
    expect(web).toContain("'your plan'")
    expect(web).toContain('`' + head + '${plan}' + tail + '`')
  })

  it('the plan in the sentence carries the name the web gives that tier', () => {
    // The web builds the name with tierDisplayName, which reads TIERS.
    expect(web).toContain('`your ${tierDisplayName(tier)} plan`')
    const pricing = readFileSync(PRICING_FILE, 'utf8')
    const webNames: Record<string, string> = {}
    for (const m of pricing.matchAll(/\bid: '([a-z-]+)',\s*name: '([^']+)',\s*monthlyEUR: \d/g)) {
      webNames[m[1]] = m[2]
    }
    // Every tier a subscription pays for, and no other.
    expect(Object.keys(webNames).sort()).toEqual(['hosted', 'hosted-max', 'hosted-pro'])
    expect(PLAN_NAMES).toEqual(webNames)
    for (const [tier, name] of Object.entries(webNames)) {
      expect(pastDueLine(tier)).toContain(`your ${name} plan`)
    }
  })
})
