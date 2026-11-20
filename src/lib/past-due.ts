// A renewal payment that failed (license.pastDue in /api/me), in the words the
// web account page uses (the web app). The sentences are
// copied, not rephrased, and a parity test holds them to the web source.
//
// House rule: none of this is rendered in or above a prompt field. A failed
// payment is an account matter and is shown where the account is managed.

import type { CloudMe } from '../api/cloud/jobs'

/** Plan names as the web writes them (TIERS in the web app), which
 *  is also how they stand on the invoice. */
export const PLAN_NAMES: Record<string, string> = {
  hosted: 'Hosted',
  'hosted-pro': 'Hosted Pro',
  'hosted-max': 'Hosted Max',
}

/** The sentence that replaces "No active plan" while a renewal is unpaid. */
export function pastDueLine(tier: string | null): string {
  const name = tier ? PLAN_NAMES[tier] : undefined
  const plan = name ? `your ${name} plan` : 'your plan'
  return `The last payment for ${plan} failed, so the plan is paused. Pay the open invoice to bring it back.`
}

/** Added when pack credits keep the account working in the meantime. */
export const PAST_DUE_WALLET_LINE = 'Credits you bought stay usable in the meantime.'

export const PAST_DUE_ACTION = 'Pay open invoice'

/** Stands where "No active plan" stood while nothing else is active. */
export const PAST_DUE_BADGE = 'Payment failed'

/**
 * Reads the two fields off /api/me. A server from before 2026-10-05 does not
 * send them, and that reads as "no failed payment": only a literal true counts.
 */
export function pastDueFromLicense(license: CloudMe['license'] | null | undefined): {
  pastDue: boolean
  pastDueTier: string | null
} {
  const pastDue = license?.pastDue === true
  return { pastDue, pastDueTier: pastDue ? (license?.pastDueTier ?? null) : null }
}
