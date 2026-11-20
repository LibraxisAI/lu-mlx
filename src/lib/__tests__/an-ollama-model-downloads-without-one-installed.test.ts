/**
 * Discord 2026-09-15 and 2026-09-20: "It won't let me download
 * Ollama models unless I have Ollama models installed". The pull demanded an
 * Ollama model active in the chat picker, and the picker had none to pick.
 *
 * Run: npx vitest run src/lib/__tests__/an-ollama-model-downloads-without-one-installed.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ollamaOnlyDownloadBlock } from '../text-download-target'

describe('an Ollama-only model', () => {
  it('downloads whenever Ollama is on, whatever the chat picker holds', () => {
    expect(ollamaOnlyDownloadBlock('Qwen 3.8 27B (Ollama)', true)).toBeNull()
  })

  it('says what to switch on when Ollama is off', () => {
    expect(ollamaOnlyDownloadBlock('Qwen 3.8 27B (Ollama)', false)).toMatch(/Enable the Ollama provider/)
  })

  it('is the only gate the Discover download asks', () => {
    const src = readFileSync('src/components/models/DiscoverModels.tsx', 'utf8')
    expect(src).toContain('ollamaOnlyDownloadBlock(model.name')
    expect(src).not.toMatch(/Switch the chat picker to an Ollama model/)
  })
})
