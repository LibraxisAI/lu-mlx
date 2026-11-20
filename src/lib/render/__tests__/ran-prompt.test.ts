import { describe, expect, it } from 'vitest'
import { hasPromptPanel, ranPrompt } from '../ran-prompt'

describe('ranPrompt', () => {
  it('gives the saved prompt, trimmed', () => {
    expect(ranPrompt({ prompt: '  a lighthouse at dusk \n', type: 'image' })).toBe('a lighthouse at dusk')
    expect(ranPrompt({ prompt: 'a wave', type: 'video', intent: 'video', label: 'Preset · step 2' })).toBe('a wave')
  })

  it('gives nothing for an entry that saved none', () => {
    expect(ranPrompt({ prompt: '', type: 'image' })).toBe('')
    expect(ranPrompt({ prompt: undefined as unknown as string, type: 'image' })).toBe('')
  })

  it('never passes the name of a run off as its prompt', () => {
    expect(ranPrompt({ prompt: 'Upscaled image', label: 'Upscaled image', type: 'image' })).toBe('')
    for (const intent of ['removebg', 'upscale', 'eraser', 'lipsync', 'motion'] as const) {
      expect(ranPrompt({ prompt: 'Some run name', type: intent === 'lipsync' || intent === 'motion' ? 'video' : 'image', intent })).toBe('')
    }
  })

  it('keeps the text of a voice line, which is what the voice says', () => {
    expect(ranPrompt({ prompt: 'Hello there.', type: 'audio', intent: 'lipsync' })).toBe('Hello there.')
  })
})

describe('hasPromptPanel', () => {
  it('is true for a prompt, a rewrite or a failed rewrite, and false for none of them', () => {
    expect(hasPromptPanel({ prompt: 'a wave' })).toBe(true)
    expect(hasPromptPanel({ prompt: '', promptOriginal: 'mine' })).toBe(true)
    expect(hasPromptPanel({ prompt: '', improveFailed: true })).toBe(true)
    expect(hasPromptPanel({ prompt: '' })).toBe(false)
    expect(hasPromptPanel({ prompt: 'Background removed', label: 'Background removed', intent: 'removebg', type: 'image' })).toBe(false)
  })
})
