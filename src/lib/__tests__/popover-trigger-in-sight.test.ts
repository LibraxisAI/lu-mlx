import { describe, it, expect } from 'vitest'
import { ankerInSicht } from '../popover-placement'

/**
 * A popover whose trigger is scrolled out of its panel is taken out of sight
 * instead of hanging in the window. The measuring itself needs a layout and is
 * covered in `e2e/popover-stays-with-a-visible-trigger.spec.ts`; here stands
 * the decision that follows from two boxes.
 */

/** The scrolling panel of the advanced settings in Create, as measured at 1280x560. */
const PANEL = { top: 147, bottom: 551, left: 904, right: 1271 }

const trigger = (top: number, left = 922) => ({ top, bottom: top + 30, left, right: left + 330 })

describe('a trigger counts as in sight while any part of it is inside the clipping area', () => {
  it('a trigger in the middle of its panel is in sight', () => {
    expect(ankerInSicht(trigger(300), PANEL)).toBe(true)
  })

  it('the measured case: the trigger stands below the panel and below the window', () => {
    expect(ankerInSicht({ top: 805, bottom: 835, left: 922, right: 1252 }, PANEL)).toBe(false)
  })

  it('a trigger scrolled out above the panel is out of sight', () => {
    expect(ankerInSicht(trigger(100), PANEL)).toBe(false)
  })

  it('a trigger that is cut by an edge is still in sight', () => {
    expect(ankerInSicht(trigger(130), PANEL)).toBe(true)
    expect(ankerInSicht(trigger(540), PANEL)).toBe(true)
  })

  it('touching the edge from outside is out of sight', () => {
    expect(ankerInSicht(trigger(117), PANEL)).toBe(false)
    expect(ankerInSicht(trigger(551), PANEL)).toBe(false)
  })

  it('a bar that scrolls sideways counts the same way', () => {
    expect(ankerInSicht(trigger(300, 1271), PANEL)).toBe(false)
    expect(ankerInSicht(trigger(300, 574), PANEL)).toBe(false)
    expect(ankerInSicht(trigger(300, 1200), PANEL)).toBe(true)
  })

  it('without a scrolling ancestor the area has no edge and every trigger is in sight', () => {
    const open = { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity }
    expect(ankerInSicht({ top: 805, bottom: 835, left: 922, right: 1252 }, open)).toBe(true)
  })

  it('an area with nothing left of it shows no trigger', () => {
    expect(ankerInSicht(trigger(300), { top: 400, bottom: 300, left: 904, right: 1271 })).toBe(false)
  })
})
