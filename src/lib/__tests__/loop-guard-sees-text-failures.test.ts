/**
 * Bug hunt 01.10.2026: a tool that reports its failure as text comes back from
 * the executor as `completed`. The loop guard was fed `status === 'failed'`,
 * so `npm test` failing six times in a row (`Error (1): …`) read as six
 * successful non-read calls: the failure streak never grew and was even reset
 * every round, and the run went on to the 200-round budget, resending the
 * whole context each step.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentLoopGuard } from '../agent-loop-guard'
import { resultFailed } from '../../api/agents/tool-executor'

const npmTestFails = { status: 'completed' as const, result: 'Error (1):\nnpm ERR! Test failed.  See above for more details.' }

describe('the loop guard sees failures a tool reports as text', () => {
  it('six rounds of a failing shell command halt the run', () => {
    const g = new AgentLoopGuard()
    const verdicts = Array.from({ length: 6 }, () =>
      g.recordResults([{ name: 'shell_execute', failed: resultFailed(npmTestFails), error: 'Error (1)' }]),
    )
    expect(verdicts[2].action).toBe('steer')
    expect(verdicts[5].action).toBe('halt')
  })

  it('NEGATIVE CONTROL: fed status alone, the same run is never stopped', () => {
    const g = new AgentLoopGuard()
    const verdicts = Array.from({ length: 12 }, () =>
      g.recordResults([{ name: 'shell_execute', failed: npmTestFails.status === ('failed' as string) }]),
    )
    expect(verdicts.every((v) => v.action === 'ok')).toBe(true)
  })

  it('reads the forms our tools fail in, and nothing else', () => {
    expect(resultFailed({ status: 'failed', result: undefined })).toBe(true)
    expect(resultFailed({ status: 'completed', result: 'Web search failed: timeout' })).toBe(true)
    expect(resultFailed({ status: 'cached', result: 'Error: 500' })).toBe(true)
    expect(resultFailed({ status: 'completed', result: 'Found 3 results for "rocket launch"' })).toBe(false)
    expect(resultFailed({ status: 'completed', result: 'ok' })).toBe(false)
    expect(resultFailed({ status: 'rejected', result: 'Error: no' })).toBe(false)
  })

  it('both loops feed the guard through it', () => {
    for (const hook of ['useAgentChat.ts', 'useCodex.ts']) {
      const src = readFileSync(resolve(__dirname, '../../hooks', hook), 'utf8')
      expect(src).toMatch(/loopGuard\.recordResults\(\s*results\.map\(\(r\) => \(\{ name: r\.toolName, failed: resultFailed\(r\)/)
      expect(src).not.toMatch(/failed: r\.status === 'failed'/)
    }
  })
})
