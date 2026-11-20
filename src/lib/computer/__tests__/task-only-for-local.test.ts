/**
 * A model that runs on this machine works on the screen through
 * computer_task alone. Step by step in the chat (computer_use) it carried
 * every look in the history of the chat and went in circles until the
 * context was full (box, 09.10.2026).
 *
 * Run: npx vitest run src/lib/computer/__tests__/task-only-for-local.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const lan = vi.hoisted(() => ({ on: true }))
vi.mock('../../lan-openai-slot', () => ({ sendsToALanBackend: (providerId: string) => providerId === 'openai' && lan.on }))

import { COMPUTER_TASK_TOOL_NAME, COMPUTER_USE_TOOL_NAME, onlyTheTaskForTheScreen } from '../prompt'

const both = (name: string) => name === COMPUTER_TASK_TOOL_NAME || name === COMPUTER_USE_TOOL_NAME

describe('which tool a model gets for the screen', () => {
  it('local models get the task alone, cloud models keep both', () => {
    lan.on = true
    expect(onlyTheTaskForTheScreen('ollama', both)).toBe(true)
    expect(onlyTheTaskForTheScreen('openai', both)).toBe(true)
    expect(onlyTheTaskForTheScreen('lu-cloud', both)).toBe(false)
    expect(onlyTheTaskForTheScreen('anthropic', both)).toBe(false)
    lan.on = false
    expect(onlyTheTaskForTheScreen('openai', both)).toBe(false)
  })

  it('without the task tool nothing is taken away: the step tool is all there is', () => {
    lan.on = true
    expect(onlyTheTaskForTheScreen('ollama', (name) => name === COMPUTER_USE_TOOL_NAME)).toBe(false)
  })

  it('the chat applies it to every list of tools it builds', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../../hooks/useAgentChat.ts'), 'utf8')
    expect(source).toMatch(/const toolMatchesCurated = [\s\S]{0,260}screenByTaskOnly && name === COMPUTER_USE_TOOL_NAME/)
  })
})
