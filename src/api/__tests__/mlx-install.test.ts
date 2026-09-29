import { describe, expect, it } from 'vitest'
import { starterForEmptyImageLane } from '../mlx-install'

describe('starterForEmptyImageLane', () => {
  it('does not download a second model after engine setup pre-pulled one', () => {
    expect(starterForEmptyImageLane([
      { sizeBytes: 2_600_000_000, installed: true, id: 'starter' },
      { sizeBytes: 4_400_000_000, installed: false, id: 'next' },
    ])).toBeNull()
  })

  it('picks the smallest model when the lane really is empty', () => {
    expect(starterForEmptyImageLane([
      { sizeBytes: 7_000_000_000, installed: false, id: 'large' },
      { sizeBytes: 2_600_000_000, installed: false, id: 'starter' },
    ])?.id).toBe('starter')
  })
})
