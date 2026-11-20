import { describe, expect, it } from 'vitest'
import { CallIdMap, MAX_WIRE_ID_CHARS } from '../call-ids'

const SAFE = /^[A-Za-z0-9_-]{1,200}$/

describe('CallIdMap', () => {
  it('keeps an id that is already safe', () => {
    const ids = new CallIdMap()
    expect(ids.alias('call_abc-123')).toBe('call_abc-123')
  })

  it('gives every id from a cloud model a safe alias', () => {
    const ids = new CallIdMap()
    for (const wire of ['functions.shell:0', 'call_abc|fc_123', 'toolu/01 A', 'ü', 'a'.repeat(400), '../../etc', '<script>']) {
      expect(ids.alias(wire)).toMatch(SAFE)
    }
  })

  it('gives the same id the same alias every time', () => {
    const ids = new CallIdMap()
    const first = ids.alias('functions.shell:0')
    ids.alias('functions.shell:1')
    expect(ids.alias('functions.shell:0')).toBe(first)
    expect(ids.size).toBe(2)
  })

  it('never gives two ids the same alias', () => {
    const ids = new CallIdMap()
    const wires = ['call:1', 'call.1', 'call/1', 'call-1', 'call-2', 'call 1', 'call-3', 'call:2']
    const aliases = wires.map((wire) => ids.alias(wire))
    expect(new Set(aliases).size).toBe(wires.length)
  })

  it('does not let a later safe id take the name of an alias already given out', () => {
    const ids = new CallIdMap()
    const generated = ids.alias('a:b')!
    const later = ids.alias(generated)!
    expect(later).not.toBe(generated)
    expect(later).toMatch(SAFE)
  })

  it('does not let a generated alias take the name of a safe id already seen', () => {
    const ids = new CallIdMap()
    expect(ids.alias('call-1')).toBe('call-1')
    expect(ids.alias('x:y')).not.toBe('call-1')
  })

  it('refuses what cannot be an id', () => {
    const ids = new CallIdMap()
    for (const bad of ['', 'x'.repeat(MAX_WIRE_ID_CHARS + 1), 7, null, undefined, {}, ['a']]) {
      expect(ids.alias(bad)).toBeNull()
    }
    expect(ids.size).toBe(0)
    expect(ids.alias('x'.repeat(MAX_WIRE_ID_CHARS))).toMatch(SAFE)
  })

  it('forgets everything on clear', () => {
    const ids = new CallIdMap()
    ids.alias('a:b')
    ids.clear()
    expect(ids.size).toBe(0)
    expect(ids.alias('c:d')).toBe('call-1')
  })
})
