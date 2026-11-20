// @vitest-environment jsdom
/**
 * R5-51: signalCreditsExhausted() and the dialog it opens used to know only
 * one reason ('credits'). The cloud Create hooks already distinguished three
 * server codes (credits_exhausted, video_budget_exhausted, trainings_exhausted,
 * see throttleMessage in useCloudCreate.ts) but only the first one opened the
 * dialog; the other two only printed a line the customer had no button under.
 * Matches the web app and
 * the web app.
 *
 * Run: npx vitest run src/components/layout/__tests__/drei-gruende-drei-titel.test.tsx
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { CreditsExhaustedModal } from '../CreditsExhaustedModal'
import { CREDITS_EXHAUSTED_EVENT, signalCreditsExhausted } from '../../../lib/credits-exhausted'

afterEach(() => cleanup())

describe('R5-51: three reasons, three titles', () => {
  it('credits (the default) shows the original title', () => {
    render(<CreditsExhaustedModal />)
    act(() => signalCreditsExhausted('credits'))
    expect(screen.getByText("You're out of credits")).toBeTruthy()
  })

  it('video_budget shows its own title and body, no plan-credits sentence', () => {
    render(<CreditsExhaustedModal />)
    act(() => signalCreditsExhausted('video_budget'))
    expect(screen.getByText("This month's video budget is used up")).toBeTruthy()
    expect(screen.getByText(/monthly video budget is spent/)).toBeTruthy()
  })

  it('trainings shows its own title and body', () => {
    render(<CreditsExhaustedModal />)
    act(() => signalCreditsExhausted('trainings'))
    expect(screen.getByText('Top up to keep training')).toBeTruthy()
    expect(screen.getByText(/included trainings refill/)).toBeTruthy()
  })

  it('a raw event with no detail (e.g. a plain Event) still falls back to credits', () => {
    render(<CreditsExhaustedModal />)
    act(() => { window.dispatchEvent(new Event(CREDITS_EXHAUSTED_EVENT)) })
    expect(screen.getByText("You're out of credits")).toBeTruthy()
  })

  it('NEGATIVE CONTROL: the video_budget and trainings titles are not the default title', () => {
    render(<CreditsExhaustedModal />)
    act(() => signalCreditsExhausted('video_budget'))
    expect(screen.queryByText("You're out of credits")).toBeNull()
  })
})
