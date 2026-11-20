/**
 * file_edit, the three additions of 30.09.2026: a whitespace-tolerant line
 * match when the exact text is not there, replace_all, and several edits in
 * one call. Every failed edit on a paid provider meant "read again, retry",
 * two more full-context round trips.
 *
 * Run: npx vitest run src/lib/__tests__/surgical-edit-tolerant.test.ts
 */
import { describe, it, expect } from 'vitest'
import { applyUniqueEdit, applyEdits, editsFromArgs } from '../surgical-edit'

const FILE = [
  'export function add(a, b) {',
  '    const sum = a + b',
  '    return sum',
  '}',
  '',
].join('\n')

describe('whitespace-tolerant match', () => {
  it('finds the lines when the model got the indentation wrong, and keeps the file level', () => {
    const r = applyUniqueEdit(FILE, 'const sum = a + b\nreturn sum', 'const total = a + b\nreturn total')
    expect(r.ok).toBe(true)
    expect(r.fuzzy).toBe(true)
    expect(r.content).toBe(FILE.replace('    const sum = a + b\n    return sum', '    const total = a + b\n    return total'))
  })

  it('shifts a differently indented new_string to the file indentation', () => {
    const r = applyUniqueEdit(FILE, '\tconst sum = a + b', '\tconst sum = a + b\n\tconsole.log(sum)')
    expect(r.fuzzy).toBe(true)
    expect(r.content).toContain('    const sum = a + b\n    console.log(sum)\n    return sum')
  })

  it('keeps CRLF files CRLF', () => {
    const crlf = FILE.replace(/\n/g, '\r\n')
    const r = applyUniqueEdit(crlf, 'return sum', 'return sum * 1')
    expect(r.content).toBe(crlf.replace('return sum', 'return sum * 1'))
    const fuzzy = applyUniqueEdit(crlf, 'const sum = a + b\nreturn sum', 'return a + b')
    expect(fuzzy.ok).toBe(true)
    expect(fuzzy.content).not.toMatch(/(?<!\r)\n/)
  })

  it('refuses when the tolerant match is ambiguous', () => {
    const twice = 'if (x) {\n  go()\n}\nif (x) {\n    go()\n}\n'
    expect(applyUniqueEdit(twice, 'go()', 'stop()').reason).toBe('not_unique')
    expect(applyUniqueEdit(twice, '   go()  ', 'stop()').reason).toBe('not_unique')
  })

  it('still says not_found when nothing matches', () => {
    expect(applyUniqueEdit(FILE, 'return difference', 'x').reason).toBe('not_found')
  })
})

describe('replace_all', () => {
  it('replaces every occurrence', () => {
    const r = applyUniqueEdit('foo(); foo(); bar()', 'foo', 'baz', true)
    expect(r).toMatchObject({ ok: true, content: 'baz(); baz(); bar()', matches: 2 })
  })
  it('without it, two matches stay refused', () => {
    expect(applyUniqueEdit('foo(); foo()', 'foo', 'baz').reason).toBe('not_unique')
  })
})

describe('several edits in one call', () => {
  it('applies them in order', () => {
    const r = applyEdits(FILE, [
      { old_string: 'add(a, b)', new_string: 'add(a, b, c = 0)' },
      { old_string: 'a + b', new_string: 'a + b + c' },
    ])
    expect(r.ok).toBe(true)
    expect(r.content).toContain('add(a, b, c = 0)')
    expect(r.content).toContain('const sum = a + b + c')
  })

  it('is all or nothing and names the failing edit', () => {
    const r = applyEdits(FILE, [
      { old_string: 'add(a, b)', new_string: 'plus(a, b)' },
      { old_string: 'does not exist', new_string: 'x' },
    ])
    expect(r).toMatchObject({ ok: false, reason: 'not_found', failedIndex: 1 })
    expect(r.content).toBeUndefined()
  })

  it('reads both argument shapes', () => {
    expect(editsFromArgs({ old_string: 'a', new_string: 'b' })).toEqual([{ old_string: 'a', new_string: 'b', replace_all: false }])
    expect(editsFromArgs({ edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] }))
      .toEqual([{ old_string: 'a', new_string: 'b', replace_all: true }])
    expect(editsFromArgs({ old_string: 'a' })[0].new_string).toBeUndefined()
  })
})
