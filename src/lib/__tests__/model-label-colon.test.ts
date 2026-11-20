/**
 * F3 (3.0.1, T4 Nebenfund): the chat model button showed only "Model: C" for
 * a name that continues past a colon, ModelSelector.tsx applied
 * `.split(':')[0]` on TOP of `displayModelName` (which already strips only
 * the `provider::model` prefix), so an Ollama tag like
 * "llama3.1:8b-instruct-q4_K_M" lost everything from its own colon onward.
 * The dropdown row right below it never did that split and showed the real
 * name, so the header and the list disagreed about the same model.
 *
 * This is the exact expression the button now uses:
 * `shortModelLabel(displayModelName(name))`, no `.split(':')` in between.
 *
 * Run: npx vitest run src/lib/__tests__/model-label-colon.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shortModelLabel, modelDisplayLabel } from '../model-label'
import { displayModelName } from '../../api/providers/model-name'

describe('F3: the model header keeps everything after a colon', () => {
  it('a plain Ollama tag survives whole', () => {
    const name = 'llama3.1:8b-instruct-q4_K_M'
    expect(shortModelLabel(displayModelName(name))).toBe('llama3.1:8b-instruct-q4_K_M')
  })

  it('the provider:: prefix is still the only thing stripped', () => {
    const name = 'anthropic::claude-opus-4:20260501'
    expect(shortModelLabel(displayModelName(name))).toBe('claude-opus-4:20260501')
  })

  it('a name with no colon at all is unaffected', () => {
    expect(shortModelLabel(displayModelName('qwen2.5-0.5b-instruct'))).toBe('qwen2.5-0.5b-instruct')
  })

  it('ModelSelector.tsx no longer truncates the header at the first colon', () => {
    const src = readFileSync(resolve(__dirname, '../../components/models/ModelSelector.tsx'), 'utf8')
    expect(src).not.toContain("displayModelName(gezeigtesModell).split(':')[0]")
    expect(src).toContain('modelDisplayLabel(models, gezeigtesModell)')
  })

  it('the shared label keeps the full Ollama tag and prefers the catalogue name', () => {
    expect(modelDisplayLabel([], 'ollama::llama3.1:8b-instruct-q4_K_M')).toBe(
      shortModelLabel(displayModelName('ollama::llama3.1:8b-instruct-q4_K_M')),
    )
    expect(modelDisplayLabel([], 'ollama::llama3.1:8b-instruct-q4_K_M')).toContain('8b-instruct')
    expect(modelDisplayLabel([{ name: 'lu-cloud::moonshotai/Kimi-K2.6', displayName: 'Kimi K2.6' }], 'lu-cloud::moonshotai/Kimi-K2.6')).toBe('Kimi K2.6')
    // The answer bubble keeps the bare id; it still gets the catalogue name.
    expect(modelDisplayLabel([{ name: 'lu-cloud::moonshotai/Kimi-K2.6', displayName: 'Kimi K2.6' }], 'moonshotai/Kimi-K2.6')).toBe('Kimi K2.6')
  })
})
