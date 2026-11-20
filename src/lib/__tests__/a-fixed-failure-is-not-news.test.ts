/**
 * Gegenprobe 01.10.2026: Mistral wrote poem.txt to the Desktop first, the
 * folder guard refused it, the next step wrote poem.txt into the chat's own
 * folder, and the run ended well. The steps header still showed red and a
 * line said "then ask again". A failure the run fixed itself is not news.
 *
 * Run: npx vitest run src/lib/__tests__/a-fixed-failure-is-not-news.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isRecovered, hasUnrecoveredFailure } from '../recovered-failure'
import { hasUnrecoveredOutsideRefusal } from '../workspace-refusal'

const REFUSED = 'Path escapes the allowed workspace: C:\\Users\\x\\Desktop\\poem.txt'
const step = (toolName: string, status: string, path?: string, error?: string) =>
  ({ toolName, status, args: path ? { path } : {}, error })

describe('a failure the run fixed itself', () => {
  const poemRun = [
    step('file_write', 'failed', 'C:\\Users\\x\\Desktop\\poem.txt', REFUSED),
    step('file_write', 'completed', 'poem.txt'),
    step('file_read', 'completed', 'poem.txt'),
  ]

  it('the box run: the header stays calm and no "ask again" line', () => {
    expect(isRecovered(poemRun, 0)).toBe(true)
    expect(hasUnrecoveredFailure(poemRun)).toBe(false)
    expect(hasUnrecoveredOutsideRefusal(poemRun)).toBe(false)
  })

  it('a refused file the run never got: the line and the mark stay', () => {
    const run = [step('file_read', 'failed', 'C:\\data\\sales.csv', REFUSED), step('file_list', 'completed', '.')]
    expect(hasUnrecoveredFailure(run)).toBe(true)
    expect(hasUnrecoveredOutsideRefusal(run)).toBe(true)
  })

  it('another file of the same tool is no fix', () => {
    const run = [step('file_read', 'failed', 'C:\\data\\sales.csv', REFUSED), step('file_read', 'completed', 'notes.txt')]
    expect(isRecovered(run, 0)).toBe(false)
  })

  it('a success BEFORE the failure is no fix', () => {
    const run = [step('file_write', 'completed', 'a.txt'), step('file_write', 'failed', 'a.txt')]
    expect(hasUnrecoveredFailure(run)).toBe(true)
  })

  it('tools without a path: a later success of the same tool fixes it', () => {
    const run = [step('web_search', 'failed'), step('web_search', 'completed')]
    expect(hasUnrecoveredFailure(run)).toBe(false)
  })

  it('a rejection by the user still marks the header, a tick would claim it ran', () => {
    expect(hasUnrecoveredFailure([step('shell_execute', 'rejected')])).toBe(true)
  })
})
