import { describe, expect, it } from 'vitest'
import { SCREEN_RUN_STAND_IN, memoryPairForRun } from '../memory-policy'

describe('memoryPairForRun', () => {
  it('passes a run without screen tools through', () => {
    expect(memoryPairForRun({ user: 'I live in Berlin.', assistant: 'Noted.', toolNames: ['web_search'], sourceKind: 'chat' }))
      .toEqual({ user: 'I live in Berlin.', assistant: 'Noted.', sourceKind: 'chat' })
  })

  for (const name of ['computer_use', 'computer_task', 'screenshot']) {
    it(`keeps what ${name} saw out of the record and marks the source`, () => {
      const pair = memoryPairForRun({
        user: 'Remember that I prefer dark mode. Now open my mail.',
        assistant: 'The inbox shows a message from Anna Example about her diagnosis.',
        toolNames: ['web_search', name], sourceKind: 'chat',
      })
      expect(pair.user).toContain('dark mode')
      expect(pair.assistant).toBe(SCREEN_RUN_STAND_IN)
      expect(pair.assistant).not.toContain('Anna')
      expect(pair.sourceKind).toBe('screen')
    })
  }
})

describe('the stand-in of a screen run', () => {
  it('states what happened and carries no instruction the extraction could save as a memory', async () => {
    const { SCREEN_RUN_STAND_IN } = await import('../memory-policy')
    // Seen on the box: "Only remember what the user said ..." came back as a
    // memory of the user called "Memory scope guidelines".
    expect(SCREEN_RUN_STAND_IN).not.toMatch(/\b(remember|only|never|do not|don't|must|should)\b/i)
    expect(SCREEN_RUN_STAND_IN).toMatch(/worked on the screen/)
  })
})
