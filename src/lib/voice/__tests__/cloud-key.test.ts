import { describe, expect, it } from 'vitest'
import { SIGNED_OUT_MESSAGE, cloudKeyStep } from '../cloud-key'

describe('cloudKeyStep', () => {
  it('keeps a key that is still the current token', () => {
    expect(cloudKeyStep('token-a', 'token-a')).toEqual({ kind: 'keep' })
  })

  it('hands a renewed token to the voice loop', () => {
    expect(cloudKeyStep('token-a', 'token-b')).toEqual({ kind: 'renew', key: 'token-b' })
  })

  it('ends the session when the sign-in is gone, and says what to do', () => {
    expect(cloudKeyStep('token-a', null)).toEqual({ kind: 'signed-out' })
    expect(cloudKeyStep('token-a', '')).toEqual({ kind: 'signed-out' })
    expect(SIGNED_OUT_MESSAGE).toMatch(/Sign in again and start a new session/)
  })
})
