import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Ticket 0004 (2026-09-05): the setup failure under the Set up
// trainer button was cut after one line, "...CHECK THAT YOU ARE ONLINE AN...",
// so the customer never saw the cause the sentence went on to name, and neither
// did the mods who read his screenshot. A note that carries a diagnosis and a
// way out has to wrap.
describe('the note under the trainer buttons', () => {
  const src = readFileSync(resolve(__dirname, '..', 'SpecialIntentControls.tsx'), 'utf8')
  const notes = src.split('\n').filter((l) => l.includes('{note && <div'))

  it('exists for setup, base download and reinstall', () => {
    expect(notes).toHaveLength(3)
  })

  it('wraps instead of being cut after one line', () => {
    for (const line of notes) {
      expect(line).not.toContain('truncate')
      expect(line).toContain('break-words')
      expect(line).toContain('max-h-40')
      expect(line).toContain('overflow-y-auto')
      expect(line).toContain('select-text')
      expect(line).toContain('whitespace-pre-wrap')
      expect(line).toContain('tabIndex={0}')
      expect(line).toContain('role="status"')
    }
  })
})
