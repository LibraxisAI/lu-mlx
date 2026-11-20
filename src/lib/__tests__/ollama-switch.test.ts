/**
 * The rule of the Ollama load switch in the model picker (lib/ollama-switch.ts).
 *
 * Run: npx vitest run src/lib/__tests__/ollama-switch.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ollamaSwitchState, waitingForSentence, stillBusySentence, switchFailedSentence } from '../ollama-switch'

describe('the switch of an Ollama row', () => {
  it('loads or unloads when nothing runs', () => {
    expect(ollamaSwitchState('a', null)).toBe('idle')
  })

  it('is the Cancel of its own load', () => {
    expect(ollamaSwitchState('a', { name: 'a', kind: 'load' })).toBe('cancel')
  })

  it('has nothing to cancel during its own unload', () => {
    expect(ollamaSwitchState('a', { name: 'a', kind: 'unload' })).toBe('busy')
  })

  it('is off while another row loads or unloads', () => {
    expect(ollamaSwitchState('b', { name: 'a', kind: 'load' })).toBe('off')
    expect(ollamaSwitchState('b', { name: 'a', kind: 'unload' })).toBe('off')
  })
})

describe('an Ollama switch and the rows', () => {
  // The rows are switched off by `pickInFlight`, and only by it. An Ollama
  // switch must not be part of that: a pick of an Ollama model loads nothing,
  // and holding it back would be the lock this rule exists to remove. The e2e
  // spec clicks a row during a held load; this pins the line itself.
  it('does not switch the rows off', () => {
    const picker = readFileSync(resolve(__dirname, '../../components/models/ModelSelector.tsx'), 'utf8')
    const line = picker.match(/const pickInFlight = (.*)/)?.[1] ?? ''
    expect(line).toBe('selectingLms !== null || togglingLms !== null')
  })
})

describe('what the picker says', () => {
  it('names the model a load waits for', () => {
    expect(waitingForSentence([])).toBeNull()
    expect(waitingForSentence(['Qwen 27B'])).toBe('Waiting for Qwen 27B to finish.')
    expect(waitingForSentence(['Qwen 27B', 'a', 'b'])).toBe('Waiting for Qwen 27B and 2 more to finish.')
  })

  it('does not call a busy model unloaded', () => {
    expect(stillBusySentence(['Qwen 27B'])).toBe('Qwen 27B is still busy. It unloads when the running answer ends.')
    expect(stillBusySentence(['a', 'b'])).toBe('2 models are still busy. They unload when the running answers end.')
  })

  it('says what failed, with the backend\'s reason when there is one', () => {
    expect(switchFailedSentence('load', 'Qwen 9B', { timedOut: true })).toBe('Loading Qwen 9B took too long and was stopped. Try again.')
    expect(switchFailedSentence('unload', 'Qwen 9B', { timedOut: true })).toBe('Ollama did not answer the unload of Qwen 9B. Try again.')
    expect(switchFailedSentence('load', 'Qwen 9B', { timedOut: false, reason: 'The model file is missing.' }))
      .toBe('Could not load Qwen 9B. The model file is missing.')
    expect(switchFailedSentence('unload', 'Qwen 9B', { timedOut: false })).toBe('Could not unload Qwen 9B.')
  })

  it('uses no dash as punctuation', () => {
    const all = [
      waitingForSentence(['a']), waitingForSentence(['a', 'b']), stillBusySentence(['a']), stillBusySentence(['a', 'b']),
      switchFailedSentence('load', 'a', { timedOut: true }), switchFailedSentence('unload', 'a', { timedOut: true }),
      switchFailedSentence('load', 'a', { timedOut: false }),
    ].join(' ')
    expect(all).not.toMatch(/[–—]| - /)
  })
})
