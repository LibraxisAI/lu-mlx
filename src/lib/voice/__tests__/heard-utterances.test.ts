/**
 * A spoken command is an answer to the app, not a line of the conversation.
 *
 * Windows run A22: every "Yes" that answered a question of computer control
 * stood in the transcript as a user line ("Yes Yes").
 *
 * Run: npx vitest run src/lib/voice/__tests__/heard-utterances.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { COMMAND_VERDICT_MS, HeardUtterances } from '../heard-utterances'

/** What the voice loop sends for a command it took out: the words, then a blank. */
const BLANK = ' '

describe('what the user said, without the spoken commands', () => {
  let kept: string[]
  let heard: HeardUtterances
  beforeEach(() => {
    vi.useFakeTimers()
    kept = []
    heard = new HeardUtterances((text) => kept.push(text))
  })
  afterEach(() => vi.useRealTimers())

  it('a sentence is kept at once', () => {
    heard.final('What is on the screen?')
    expect(kept).toEqual(['What is on the screen?'])
  })

  it.each(['Yes.', 'No.', 'Stop.', 'Wait.', 'Yes, please.', 'Hold on.'])('"%s" that the voice loop took is never kept', (word) => {
    heard.final(word)
    expect(kept).toEqual([])
    heard.final(BLANK)
    vi.advanceTimersByTime(COMMAND_VERDICT_MS * 3)
    expect(kept).toEqual([])
  })

  it('two answers in a row leave nothing behind', () => {
    for (const word of ['Yes.', BLANK, 'Yes.', BLANK]) heard.final(word)
    vi.advanceTimersByTime(COMMAND_VERDICT_MS * 3)
    expect(kept).toEqual([])
  })

  it('a "yes" while nothing was asked is conversation: kept when no blank follows', () => {
    heard.final('Yes.')
    vi.advanceTimersByTime(COMMAND_VERDICT_MS - 1)
    expect(kept).toEqual([])
    vi.advanceTimersByTime(1)
    expect(kept).toEqual(['Yes.'])
    // A blank that comes later belongs to something else.
    heard.final(BLANK)
    expect(kept).toEqual(['Yes.'])
  })

  it('kept as soon as the model answers it', () => {
    heard.final('Okay.')
    heard.release()
    expect(kept).toEqual(['Okay.'])
    vi.advanceTimersByTime(COMMAND_VERDICT_MS * 3)
    expect(kept).toEqual(['Okay.'])
  })

  it('"Wait" that turned out to be the start of a sentence stays in front of the rest', () => {
    heard.final('Wait,')
    heard.final('what is two plus two?')
    expect(kept).toEqual(['Wait,', 'what is two plus two?'])
  })

  it('the end of the session keeps nothing that still waits', () => {
    heard.final('Yes.')
    heard.drop()
    vi.advanceTimersByTime(COMMAND_VERDICT_MS * 3)
    expect(kept).toEqual([])
  })
})
