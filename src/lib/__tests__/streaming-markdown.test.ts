/**
 * Gegenprobe 01.10.2026: "I created a file named `" stood with a raw backtick
 * for a second while the answer streamed. Only the frame on screen is fixed;
 * the finished answer is what the model wrote.
 *
 * Run: npx vitest run src/lib/__tests__/streaming-markdown.test.ts
 */
import { describe, it, expect } from 'vitest'
import { closeOpenMarkdown } from '../streaming-markdown'

describe('markdown still arriving', () => {
  it('the box case: a lone opening backtick at the end is left out', () => {
    expect(closeOpenMarkdown('I created a file named `')).toBe('I created a file named ')
  })

  it('an open code span is closed, so it renders as code already', () => {
    expect(closeOpenMarkdown('I created a file named `notes')).toBe('I created a file named `notes`')
  })

  it('an open bold run is closed, a bare opener at the end is left out', () => {
    expect(closeOpenMarkdown('This is **important')).toBe('This is **important**')
    expect(closeOpenMarkdown('This is **')).toBe('This is ')
  })

  it('balanced text is untouched', () => {
    const t = 'Use `npm test` and **then** commit.'
    expect(closeOpenMarkdown(t)).toBe(t)
  })

  it('only the paragraph being written counts', () => {
    const t = 'A finished `odd paragraph\n\nNow `notes'
    expect(closeOpenMarkdown(t)).toBe('A finished `odd paragraph\n\nNow `notes`')
  })

  it('inside an open fence nothing is touched', () => {
    const t = 'Here:\n```ts\nconst a = `x'
    expect(closeOpenMarkdown(t)).toBe(t)
  })

  it('after a closed fence the new paragraph is handled', () => {
    expect(closeOpenMarkdown('```\ncode `\n```\nThen `x')).toBe('```\ncode `\n```\nThen `x`')
  })

  it('asterisks inside code do not count as bold', () => {
    const t = 'Run `a ** b` now'
    expect(closeOpenMarkdown(t)).toBe(t)
  })
})
