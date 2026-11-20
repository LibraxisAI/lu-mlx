/**
 * The wiring for the retry-after fix: the header has to be read where the
 * error is built, honoured where the retry sleeps, and explained where the run
 * gives up.
 *
 * Review 2026-08-14. Before this, all three were missing: parseError dropped
 * the header, both retry sites slept on a hard-coded 1500 * attempt, and the
 * outer catch had no 429 branch, so a burst-limited run ended on the generic
 * "Agent error: too many requests".
 *
 * Run: npx vitest run src/hooks/__tests__/throttled-run-waits-it-out.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const agent = read('../useAgentChat.ts')
const provider = read('../../api/providers/openai-provider.ts')
const types = read('../../api/providers/types.ts')
const codeTab = read('../useCodex.ts')

describe('the header survives the trip to the retry site', () => {
  it('parseError puts it on the error it builds', () => {
    expect(provider).toContain('parseRetryAfter(res)')
    expect(provider).toContain("import { parseRetryAfter } from '../../lib/http-status'")
  })

  it('the error type carries it', () => {
    expect(types).toMatch(/readonly retryAfterMs\?: number/)
  })
})

describe('both retry sites honour it', () => {
  it('neither sleeps on a hard-coded ladder any more', () => {
    const code = agent
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('setTimeout(r, 1500 * connRetries)')
    expect(agent.match(/const wait = retryDelayMs\(thinkErr, connRetries\)/g)).toHaveLength(2)
    // The sleep of exactly that wait, through the helper that also shows "Retrying" while it lasts.
    expect(agent.match(/await waitBeforeRetry\(convId, wait, abort\.signal\)/g)).toHaveLength(2)
  })

  it('a long wait is announced, so a quiet minute does not read as a freeze', () => {
    expect(agent).toContain('const announceWait = (err: unknown, ms: number) =>')
    expect(agent).toContain('Rate limited by the server, which asked for')
    // Only a wait the server asked for. The 1.5 s connection blip gets no line.
    expect(agent).toContain("if (typeof asked !== 'number' || ms < 3000) return")
    expect(agent.match(/announceWait\(thinkErr, wait\)/g)).toHaveLength(2)
  })
})

describe('and giving up says when to come back', () => {
  it('the 429 branch sits before the generic error line', () => {
    const branch = agent.indexOf('} else if (httpStatusOf(err) === 429) {')
    const generic = agent.indexOf("'\\n\\nAgent error: ' + errorMsg")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(generic)
  })

  it('the sentence is the server\'s, and the app\'s own one claims nothing about the account', () => {
    const branch = agent.slice(
      agent.indexOf('} else if (httpStatusOf(err) === 429) {'),
      agent.indexOf("} else if ((err as { code?: string })?.code === 'flash_timeout') {"),
    )
    expect(branch).toContain('requestLimitMessageOf(err,')
    expect(agent).not.toContain('this account may send')
  })

  it('but an empty wallet is judged first, it answers 429 too', () => {
    const credits = agent.indexOf("code === 'credits_exhausted'")
    expect(credits).toBeGreaterThan(-1)
    expect(credits).toBeLessThan(agent.indexOf('} else if (httpStatusOf(err) === 429) {'))
  })

  it('a throttle does not kill a /loop, unlike an empty wallet', () => {
    // R5-53 added the flash_timeout branch right after this one, which DOES
    // set loopHalt (a flash timeout is final, unlike a throttle), so the end
    // anchor is that branch's own start, not the next NAMED branch further
    // down, or this slice would swallow flash_timeout's loopHalt too and
    // read as a false regression here.
    const branch = agent.slice(
      agent.indexOf('} else if (httpStatusOf(err) === 429) {'),
      agent.indexOf("} else if ((err as { code?: string })?.code === 'flash_timeout') {"),
    )
    expect(branch).not.toContain('loopHalt =')
  })
})

describe('the Code tab does the same', () => {
  it('waits the time the server names and asks again, at most twice', () => {
    expect(codeTab).toContain('if (httpStatusOf(limitErr) !== 429 || isTerminalModelError(limitErr) || limitWaits >= 2 || abort.signal.aborted) throw limitErr')
    expect(codeTab).toContain('const wait = retryDelayMs(limitErr, limitWaits)')
    expect(codeTab).toContain('await waitBeforeRetry(convId, wait, abort.signal)')
  })

  it('and ends on the same sentence, without a code and a status in front', () => {
    const limit = codeTab.indexOf('if (status === 429) {')
    expect(limit).toBeGreaterThan(-1)
    expect(limit).toBeLessThan(codeTab.indexOf('fullContent += `\\n\\nError: ${msg}${hint}`'))
    // An empty wallet answers 429 too and is judged first.
    expect(codeTab.indexOf("if (code === 'credits_exhausted') {")).toBeLessThan(limit)
    expect(codeTab.slice(limit, limit + 400)).toContain('requestLimitMessageOf(err,')
  })
})
