/**
 * Bug hunt 01.10.2026 (A7). On the native (Ollama) channel both loops wrote
 * the assistant tool_calls without ids and the tool results without
 * tool_call_id. That chain is kept as hidden history, so a switch to LU Cloud
 * in the same conversation sent id-less calls next to results a strict
 * upstream cannot tie to them: a 422, or at best a prefix that changed every
 * step and missed the upstream cache. The ids now stay on every transport.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8')

function nativeBranch(src: string): string {
  const at = src.indexOf("} else if (strategy === 'native') {\n")
  expect(at).toBeGreaterThan(0)
  return src.slice(at, src.indexOf('} else {', at))
}

describe('a native step keeps its call ids', () => {
  it('Agent tab', () => {
    const branch = nativeBranch(read('useAgentChat.ts'))
    expect(branch).toMatch(/tool_calls: toolCalls\.map\(\(tc\) => \(\{\s+id: tc\.id,/)
    expect(branch).toContain('tool_call_id: tc.id')
  })

  it('Code tab', () => {
    const branch = nativeBranch(read('useCodex.ts'))
    expect(branch).toMatch(/tool_calls: batch\.map\(\(e\) => \(\{\s+id: e\.tc\.id,/)
    expect(branch).toContain('tool_call_id: tc.id')
  })

  it('every call has an id before the batch is built, in both loops', () => {
    for (const f of ['useAgentChat.ts', 'useCodex.ts']) {
      const src = read(f)
      const ids = src.indexOf('toolCalls = toolCalls.map((tc) => (tc.id ? tc : { ...tc, id: uuid() }))')
      expect(ids, f).toBeGreaterThan(0)
      expect(ids, f).toBeLessThan(src.indexOf("} else if (strategy === 'native') {\n"))
    }
  })
})
