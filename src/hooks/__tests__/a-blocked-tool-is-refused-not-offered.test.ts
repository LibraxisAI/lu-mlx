/**
 * Bug hunt 01.10.2026 (A4). The Agent loop asked for approval on every level
 * that was not 'auto', and 'blocked' is not 'auto': a tool the user had
 * switched off got an approval card, and one click on Approve ran it. The
 * catalog leaves it out, but the loose parser lifts a call written as text and
 * the executor resolves it by name. The sub-agent and the Code tab already
 * refused; the main Agent loop is the one that asked.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveApprovalLevel } from '../../lib/agent-approval-policy'

const agent = readFileSync(resolve(__dirname, '../useAgentChat.ts'), 'utf8')

describe('a tool switched off in the permissions', () => {
  it('resolves to blocked, which is not auto, so the approval path alone would ask for it', () => {
    expect(resolveApprovalLevel('shell_execute', { categoryLevel: 'blocked', codexMode: null, readOnlyRun: false })).toBe('blocked')
    expect(agent).toMatch(/const needsApproval = \(permLevel !== 'auto' \|\| cloudShellConfirm\)/)
  })

  it('is filtered out and refused before any card is built', () => {
    const refuse = agent.indexOf("is switched off for this conversation in the tool permissions, so it was not run")
    const card = agent.indexOf("status: needsApproval ? 'pending_approval' : 'running'")
    expect(refuse).toBeGreaterThan(0)
    expect(refuse).toBeLessThan(card)
    const block = agent.slice(agent.lastIndexOf('{', refuse - 900) , refuse)
    expect(block).toMatch(/resolveApprovalLevel\(tc\.function\.name, \{\s+categoryLevel: toolRegistry\.getPermissionLevelWithOverrides\(tc\.function\.name, permissions, \{\}\),\s+override: overrides\[tc\.function\.name\],/)
    expect(block).toMatch(/=== 'blocked'/)
    expect(block).toMatch(/toolCalls = toolCalls\.filter\(\(tc\) => !isBlocked\(tc\)\)/)
  })

  it('a per-tool override that allows it still wins', () => {
    expect(resolveApprovalLevel('shell_execute', { categoryLevel: 'confirm', override: 'auto', codexMode: null, readOnlyRun: false })).toBe('auto')
  })
})
