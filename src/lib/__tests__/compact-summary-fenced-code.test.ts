import { describe, expect, it } from 'vitest'
import {
  EMPTY_SUMMARY,
  compactSummaryBody,
  parseCompactSummary,
  renderCompactSummary,
  summarySections,
} from '../compact-summary'

describe('literal code in compact summaries', () => {
  it.each(['```', '~~~'])('keeps heading-like code inside %s fences in its section', (fence) => {
    const facts = `${fence}text\nTASK\nOPEN\nNOTES\n${fence}`
    const summary = parseCompactSummary(`TASK\nRepair the parser\nFACTS\n${facts}\nOPEN\nRun the tests`)
    expect(summary.task).toBe('Repair the parser')
    expect(summary.facts).toBe(facts)
    expect(summary.open).toBe('Run the tests')
    expect(summary.rest).toBe('')
  })

  it('does not close a fence with a shorter run, another marker, or an info string', () => {
    const facts = '````text\n```\nOPEN\n~~~\nTASK\n````still-code\nNOTES\n````'
    const summary = parseCompactSummary(`FACTS\n${facts}\nOPEN\nCheck the result`)
    expect(summary.facts).toBe(facts)
    expect(summary.open).toBe('Check the result')
    expect(summary.task).toBe('')
  })

  it('accepts an indented opening and a longer closing fence without altering the code', () => {
    const facts = '   ~~~text\nOPEN\n  ~~~~~   '
    const summary = parseCompactSummary(`FACTS\n${facts}\nA fact after the fence\nOPEN\nStill pending`)
    // Only the existing section-boundary trim applies; interior whitespace is retained.
    expect(summary.facts).toBe(facts.trimStart() + '\nA fact after the fence')
    expect(summary.open).toBe('Still pending')
  })

  it('keeps the remainder of an unclosed code block in its section and closes the fence', () => {
    const facts = '```sql\nOPEN\nTASK\nNOTES'
    const summary = parseCompactSummary(`FACTS\n${facts}`)
    expect(summary.facts).toBe(facts + '\n```')
    expect(summary.open).toBe('')
  })

  it('closes an unclosed fence with the marker and length that opened it', () => {
    const summary = parseCompactSummary('FACTS\n~~~~py\nprint(1)')
    expect(summary.facts).toBe('~~~~py\nprint(1)\n~~~~')
  })

  it('does not let an unclosed fence swallow the sections rendered after it', () => {
    // Written out of order: OPEN first, then FACTS cut off inside its code.
    const summary = parseCompactSummary('OPEN\nRun the tests\nFACTS\n```ts\nconst a = 1')
    const rendered = renderCompactSummary(summary)
    expect(summarySections(rendered)).toEqual([
      { heading: 'FACTS', body: '```ts\nconst a = 1\n```' },
      { heading: 'OPEN', body: 'Run the tests' },
    ])
    // Stable from here on: a second read changes nothing.
    expect(parseCompactSummary(compactSummaryBody(rendered))).toEqual(summary)
  })

  it.each(['```', '```text', '~~~markdown'])('reads the sections of an answer wrapped whole in %s', (open) => {
    const close = open.slice(0, 3)
    const summary = parseCompactSummary(`${open}\nTASK\nRepair the parser\nFACTS\nIt is in compact-summary.ts\n${close}`)
    expect(summary).toEqual({ ...EMPTY_SUMMARY, task: 'Repair the parser', facts: 'It is in compact-summary.ts' })
  })

  it('reads a wrapped answer behind a lead-in line and keeps the text around it as notes', () => {
    const summary = parseCompactSummary('Here is the summary:\n```\nTASK\nRepair the parser\nOPEN\nnone\n```\nLet me know.')
    expect(summary).toEqual({ ...EMPTY_SUMMARY, task: 'Repair the parser', rest: 'Here is the summary:\nLet me know.' })
  })

  it('still keeps code inside a section of a wrapped answer literal', () => {
    const summary = parseCompactSummary('````\nTASK\nRepair\nFACTS\n```\nOPEN\n```\n````')
    expect(summary.task).toBe('Repair')
    expect(summary.facts).toBe('```\nOPEN\n```')
    expect(summary.open).toBe('')
  })

  it('leaves a fence inside a section alone when sections were found outside it', () => {
    const summary = parseCompactSummary('TASK\nRepair\nNOTES\n```\nFACTS\nnot a section\n```')
    expect(summary.facts).toBe('')
    expect(summary.rest).toBe('```\nFACTS\nnot a section\n```')
  })

  it('keeps a fenced answer without section headings as loose text', () => {
    const answer = '```text\nTASK\nOPEN\n```'
    expect(parseCompactSummary(answer)).toEqual({ ...EMPTY_SUMMARY, rest: answer })
  })

  it('round-trips stored code and displays it under the original heading', () => {
    const original = { ...EMPTY_SUMMARY, task: 'Inspect status constants', facts: '```ts\nOPEN\nTASK\n```', open: 'Write regression coverage' }
    const rendered = renderCompactSummary(original)
    expect(parseCompactSummary(compactSummaryBody(rendered))).toEqual(original)
    expect(summarySections(rendered)).toEqual([
      { heading: 'TASK', body: original.task },
      { heading: 'FACTS', body: original.facts },
      { heading: 'OPEN', body: original.open },
    ])
  })

  it('still recognizes decorated headings outside code blocks', () => {
    const summary = parseCompactSummary('## TASK:\nRepair\n**FACTS**\nKnown value\n- OPEN -\nVerify')
    expect(summary.task).toBe('Repair')
    expect(summary.facts).toBe('Known value')
    expect(summary.open).toBe('Verify')
  })
})
