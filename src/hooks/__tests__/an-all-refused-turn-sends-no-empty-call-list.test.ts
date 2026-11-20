/**
 * Bug hunt 01.10.2026 (A9). A read-only turn (/review, plan) or a turn whose
 * tools are all switched off can lose every call to the filters. The turn
 * then went on with an empty batch and wrote `tool_calls: []` into the
 * history, which a strict upstream rejects, behind the refusal it answers.
 */
import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const agent = readFileSync(resolve(__dirname, '..', 'useAgentChat.ts'), 'utf8')

it('a turn with every call refused goes to the next round before any batch is built', () => {
  const mark = agent.indexOf('const refusalsFrom = agentMessages.length')
  const readOnly = agent.indexOf('if (opts?.readOnly) {', mark)
  const skip = agent.indexOf('if (toolCalls.length === 0 && agentMessages.length > refusalsFrom) {')
  expect(mark).toBeGreaterThan(0)
  expect(readOnly).toBeGreaterThan(mark)
  expect(skip).toBeGreaterThan(agent.indexOf('is switched off for this conversation in the tool permissions'))
  expect(skip).toBeLessThan(agent.indexOf('type BatchEntry = {'))
  const block = agent.slice(skip, agent.indexOf('continue', skip) + 8)
  // The model's words sit before the refusal, never after it.
  expect(block).toContain("agentMessages.splice(refusalsFrom, 0, { role: 'assistant', content: turnContent })")
})
