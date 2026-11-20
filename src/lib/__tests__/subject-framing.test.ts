/**
 * GH #142: the chat image tool rendered every "full body" request in the
 * model's square default, and portrait-trained models crop a whole figure in a
 * square to the face. A prompt that asks for the whole figure now gets a tall
 * frame when nobody named a size.
 */
import { describe, expect, it } from 'vitest'
import { portraitFrame, wantsFullFigure } from '../subject-framing'

describe('wantsFullFigure', () => {
  it.each([
    'full body shot of a woman',
    'Full-body photo, studio light',
    'fullbody, standing',
    'a knight from head to toe',
    'head-to-feet view of a dancer',
    'whole body in frame',
    'entire body visible',
    'full length portrait of a man in a suit',
    'full shot, street',
    'long shot of a hiker',
  ])('%s', (prompt) => expect(wantsFullFigure(prompt)).toBe(true))

  it.each([
    'close-up portrait of a woman',
    'a bowl of fruit on a table',
    'headshot, soft light',
    'fully clothed woman sitting',
    'a bodybuilder flexing',
  ])('not: %s', (prompt) => expect(wantsFullFigure(prompt)).toBe(false))
})

describe('portraitFrame', () => {
  it('uses the trained portrait buckets', () => {
    expect(portraitFrame(512)).toEqual({ width: 512, height: 768 })
    expect(portraitFrame(1024)).toEqual({ width: 832, height: 1216 })
    expect(portraitFrame(1328)).toEqual({ width: 1056, height: 1584 })
  })

  it('keeps the pixel budget at 2:3 beyond them, on the 64 grid', () => {
    const f = portraitFrame(2048)
    expect(f.width % 64).toBe(0)
    expect(f.height % 64).toBe(0)
    expect(f.height / f.width).toBeCloseTo(1.5, 1)
  })
})
