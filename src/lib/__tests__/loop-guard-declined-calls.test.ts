/**
 * A no of the user is not a success, and a row of them is a stall.
 *
 * Seen on a Windows test machine, 09.10.2026: a 9B model asked for a made up
 * shell command, the user declined, and the model asked again in another
 * spelling, 75 times in one turn. A declined call has the status "rejected".
 * The result side of the guard only knew "failed" and "not failed", so every
 * no counted as a success and reset the count of failing rounds.
 *
 * Run: npx vitest run src/lib/__tests__/loop-guard-declined-calls.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentLoopGuard } from '../agent-loop-guard'

const declined = (command: string) => ({ name: 'shell_execute', failed: false, rejected: true, error: 'User rejected tool call', args: { command } })
const ran = (command: string, failed = false) => ({ name: 'shell_execute', failed, args: { command } })

describe('the user keeps declining the same command', () => {
  it('ends the turn at the sixth no, whatever the spelling', () => {
    const guard = new AgentLoopGuard()
    const verdicts = [1, 2, 3, 4, 5, 6].map((n) => guard.recordResults([declined(`task /create /tn job${n} /tr notepad`)]))
    expect(verdicts.slice(0, 2).map((v) => v.action)).toEqual(['ok', 'ok'])
    expect(verdicts[2].action).toBe('steer')
    expect(verdicts.slice(3, 5).map((v) => v.action)).toEqual(['ok', 'ok'])
    expect(verdicts[5]).toEqual({ action: 'halt', reason: "the user declined 6 'task' commands in a row" })
  })

  it('75 in a row are not possible any more', () => {
    const guard = new AgentLoopGuard()
    let rounds = 0
    for (; rounds < 75; rounds++) {
      if (guard.recordResults([declined(`task /create variant ${rounds}`)]).action === 'halt') break
    }
    expect(rounds + 1).toBe(6)
  })

  it('tells the model at the third no that a no is the answer', () => {
    const guard = new AgentLoopGuard()
    guard.recordResults([declined('task a')])
    guard.recordResults([declined('task b')])
    const third = guard.recordResults([declined('task c')])
    expect(third.action).toBe('steer')
    expect(third.action === 'steer' && third.message).toMatch(/declined 3 'task' commands in a row\. A no is their answer\./)
    expect(third.action === 'steer' && third.message).not.toMatch(/[–—]/)
  })

  it('a successful call of something else in between does not clear the count', () => {
    const guard = new AgentLoopGuard()
    let last = guard.recordResults([declined('task 0')])
    for (let n = 1; n < 6; n++) {
      guard.recordResults([{ name: 'file_list', failed: false, args: { path: '.' } }])
      last = guard.recordResults([declined(`task ${n}`)])
    }
    expect(last.action).toBe('halt')
  })

  it('counts a tool without a command by its name', () => {
    const guard = new AgentLoopGuard()
    const no = (path: string) => ({ name: 'file_write', failed: false, rejected: true, args: { path } })
    let last = guard.recordResults([no('a.txt')])
    for (const path of ['b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) last = guard.recordResults([no(path)])
    expect(last).toEqual({ action: 'halt', reason: "the user declined 6 'file_write' calls in a row" })
  })
})

describe('one no does not stand in the way', () => {
  it('a single no followed by a different command goes on as usual', () => {
    const guard = new AgentLoopGuard()
    expect(guard.recordResults([declined('rm -rf build')])).toEqual({ action: 'ok' })
    for (let n = 0; n < 20; n++) {
      expect(guard.recordResults([ran(`npm run step${n}`)])).toEqual({ action: 'ok' })
    }
  })

  it('the same command being let through clears its count', () => {
    const guard = new AgentLoopGuard()
    for (let round = 0; round < 4; round++) {
      for (let n = 0; n < 5; n++) expect(guard.recordResults([declined(`git push ${round} ${n}`)]).action).not.toBe('halt')
      expect(guard.recordResults([ran('git status')]).action).toBe('ok')
    }
  })

  it('a no for one command does not count against another', () => {
    const guard = new AgentLoopGuard()
    const commands = ['task a', 'schtasks b', 'at c', 'cron d', 'start e']
    for (const command of commands) expect(guard.recordResults([declined(command)]).action).toBe('ok')
  })
})

describe('a no is no success', () => {
  it('rounds of nothing but a no end the turn at the sixth, with a sentence that says so', () => {
    const guard = new AgentLoopGuard()
    const commands = ['task a', 'schtasks b', 'at c', 'cron d', 'start e', 'cmd f']
    const verdicts = commands.map((command) => guard.recordResults([declined(command)]))
    expect(verdicts[5]).toEqual({
      action: 'halt',
      reason: '6 rounds in a row where every tool call was declined by the user (shell_execute) and nothing changed in between',
    })
  })

  it('a no does not reset a run of failing rounds', () => {
    const guard = new AgentLoopGuard()
    const fail = (n: number) => ({ name: 'file_read', failed: true, error: 'not found', args: { path: `x${n}` } })
    guard.recordResults([fail(1)])
    guard.recordResults([fail(2)])
    guard.recordResults([declined('task a')])
    guard.recordResults([fail(3)])
    guard.recordResults([fail(4)])
    const sixth = guard.recordResults([fail(5)])
    expect(sixth.action).toBe('halt')
    expect(sixth.action === 'halt' && sixth.reason).toMatch(/^6 rounds in a row/)
  })

  it('a no does not clear the count of failures of a command', () => {
    const guard = new AgentLoopGuard()
    const results = [ran('npm a', true), ran('npm b', true), ran('npm c', true), declined('git reset'), ran('npm d', true), ran('npm e', true), ran('npm f', true)]
    // A file list in between keeps the rounds from all failing.
    let last = { action: 'ok' } as ReturnType<AgentLoopGuard['recordResults']>
    for (const result of results) last = guard.recordResults([result, { name: 'file_list', failed: false, args: {} }])
    expect(last.action).toBe('halt')
    expect(last.action === 'halt' && last.reason).toMatch(/6 failed 'npm' commands in a row/)
  })
})

describe('both agents hand the status over', () => {
  it.each(['useAgentChat.ts', 'useCodex.ts'])('%s', (file) => {
    const source = readFileSync(resolve(__dirname, '../../hooks', file), 'utf-8')
    expect(source).toContain("failed: resultFailed(r), rejected: r.status === 'rejected'")
  })
})
