import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spokenCommand } from '../commands'

// The same list the voice loop's own suite reads (tests/test_commands.py).
const vectors = JSON.parse(readFileSync(resolve(process.cwd(),
  'src-tauri/resources/voice_loop/tests/fixtures/voice_commands.json'), 'utf8')) as Record<'yes' | 'no' | 'stop' | 'none', string[]>

describe('spokenCommand', () => {
  for (const command of ['yes', 'no', 'stop'] as const) {
    it(`takes every listed "${command}" as one`, () => {
      expect(vectors[command].length).toBeGreaterThan(5)
      for (const text of vectors[command]) expect([text, spokenCommand(text)]).toEqual([text, command])
    })
  }

  it('leaves a sentence that only contains such a word alone', () => {
    expect(vectors.none.length).toBeGreaterThan(5)
    for (const text of vectors.none) expect([text, spokenCommand(text)]).toEqual([text, null])
  })
})
