/**
 * The rule of the LM Studio load switch in the model picker
 * (lib/lmstudio-switch.ts), and the rule both switches share
 * (lib/load-switch.ts).
 *
 * Run: npx vitest run src/lib/__tests__/lmstudio-switch.test.ts
 */
import { describe, it, expect } from 'vitest'
import { loadSwitchState, loadSwitchFailedSentence } from '../load-switch'
import { ollamaSwitchState, switchFailedSentence } from '../ollama-switch'
import {
  lmStudioSwitchState, lmStudioSwitchFailedSentence, lmStudioReason,
  LM_STUDIO_STILL_LISTED, type LmStudioSwitchRun,
} from '../lmstudio-switch'

const run = (name: string, kind: 'load' | 'unload', via: 'switch' | 'pick' = 'switch'): LmStudioSwitchRun => ({ name, kind, via })
const NONE: ReadonlySet<string> = new Set()

describe('the switch of an LM Studio row', () => {
  it('loads or unloads when nothing runs', () => {
    expect(lmStudioSwitchState('a', null, false, NONE)).toBe('idle')
  })

  it('is the Cancel of its own load, whether its switch or a pick of its row started it', () => {
    expect(lmStudioSwitchState('a', run('a', 'load', 'switch'), false, NONE)).toBe('cancel')
    expect(lmStudioSwitchState('a', run('a', 'load', 'pick'), true, NONE)).toBe('cancel')
  })

  it('has nothing to cancel during its own unload', () => {
    expect(lmStudioSwitchState('a', run('a', 'unload'), false, NONE)).toBe('busy')
  })

  it('is off while another row loads or unloads', () => {
    expect(lmStudioSwitchState('b', run('a', 'load'), false, NONE)).toBe('off')
    expect(lmStudioSwitchState('b', run('a', 'load', 'pick'), true, NONE)).toBe('off')
    expect(lmStudioSwitchState('b', run('a', 'unload'), false, NONE)).toBe('off')
  })

  it('is off, and no Cancel, while a load runs that is not LM Studio\'s', () => {
    expect(lmStudioSwitchState('a', null, true, NONE)).toBe('off')
  })

  it('is cancelling, and nothing else, while LM Studio still holds its ended load', () => {
    const ending = new Set(['a'])
    expect(lmStudioSwitchState('a', null, false, ending)).toBe('cancelling')
    expect(lmStudioSwitchState('a', run('b', 'load'), false, ending)).toBe('cancelling')
    expect(lmStudioSwitchState('a', null, true, ending)).toBe('cancelling')
  })

  it('leaves the other rows free while one is cancelling', () => {
    const ending = new Set(['a'])
    expect(lmStudioSwitchState('b', null, false, ending)).toBe('idle')
    expect(lmStudioSwitchState('b', run('b', 'load'), false, ending)).toBe('cancel')
  })
})

describe('one rule for both backends', () => {
  it('the Ollama switch is the shared rule', () => {
    expect(ollamaSwitchState).toBe(loadSwitchState)
  })

  it('the sentences differ only in the name of the backend', () => {
    for (const kind of ['load', 'unload'] as const) {
      for (const failure of [{ timedOut: true }, { timedOut: false }, { timedOut: false, reason: 'No room.' }]) {
        const ollama = switchFailedSentence(kind, 'Qwen 9B', failure)
        const lmStudio = lmStudioSwitchFailedSentence(kind, 'Qwen 9B', failure)
        expect(ollama).toBe(loadSwitchFailedSentence('Ollama', kind, 'Qwen 9B', failure))
        expect(lmStudio).toBe(ollama.replace('Ollama', 'LM Studio'))
      }
    }
  })
})

describe('what the picker says about LM Studio', () => {
  it('says what failed, with the reason when there is one', () => {
    expect(lmStudioSwitchFailedSentence('load', 'Qwen 9B', { timedOut: true })).toBe('Loading Qwen 9B took too long and was stopped. Try again.')
    expect(lmStudioSwitchFailedSentence('unload', 'Qwen 9B', { timedOut: true })).toBe('LM Studio did not answer the unload of Qwen 9B. Try again.')
    expect(lmStudioSwitchFailedSentence('load', 'Qwen 9B', { timedOut: false, reason: 'No room.' })).toBe('Could not load Qwen 9B. No room.')
    expect(lmStudioSwitchFailedSentence('unload', 'Qwen 9B', { timedOut: false, reason: LM_STUDIO_STILL_LISTED }))
      .toBe('Could not unload Qwen 9B. LM Studio still lists it as loaded.')
    expect(lmStudioSwitchFailedSentence('load', 'Qwen 9B', { timedOut: false })).toBe('Could not load Qwen 9B.')
  })

  it('uses no dash as punctuation', () => {
    const all = [
      lmStudioSwitchFailedSentence('load', 'a', { timedOut: true }), lmStudioSwitchFailedSentence('unload', 'a', { timedOut: true }),
      lmStudioSwitchFailedSentence('load', 'a', { timedOut: false }), LM_STUDIO_STILL_LISTED,
    ].join(' ')
    expect(all).not.toMatch(/[–—]| - /)
  })
})

describe('the reason the lms command gave', () => {
  it('loses the bridge prefix, colour codes and line breaks', () => {
    expect(lmStudioReason('lms load failed: \u001b[31mError:\u001b[39m Model not found.\n\n  Run lms ls.'))
      .toBe('Error: Model not found. Run lms ls.')
    expect(lmStudioReason('lms unload failed: nothing to unload')).toBe('nothing to unload')
    expect(lmStudioReason('spawn lms load: No such file or directory')).toBe('No such file or directory')
  })

  it('is left out when the command wrote nothing', () => {
    expect(lmStudioReason('lms load failed: ')).toBeUndefined()
    expect(lmStudioReason('')).toBeUndefined()
    expect(lmStudioReason(' \n ')).toBeUndefined()
  })

  it('stays one or two sentences long', () => {
    const reason = lmStudioReason(`lms load failed: ${'x'.repeat(2000)}`) ?? ''
    expect(reason.length).toBeLessThanOrEqual(243)
    expect(reason.endsWith('...')).toBe(true)
  })

  it('keeps a sentence that is not the bridge\'s own', () => {
    expect(lmStudioReason('lms CLI not found')).toBe('lms CLI not found')
  })
})
