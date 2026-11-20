/**
 * The details dialog of a chat model does not say its name twice (persona
 * walk, 09.10.2026, Fund 22). The rule holds on every platform.
 *
 * Run: npx vitest run src/lib/__tests__/model-info-title.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { modelInfoTitle } from '../model-info-title'

describe('the title of the details dialog', () => {
  it('names a model once when group and name are the same', () => {
    expect(modelInfoTitle({ name: 'Qwen 3.8 35B MoE Distill', group: 'Qwen 3.8 35B MoE Distill' })).toBe('Qwen 3.8 35B MoE Distill')
    expect(modelInfoTitle({ name: 'qwen 3.8 35B MoE Distill ', group: 'Qwen 3.8 35B MoE Distill' })).toBe('qwen 3.8 35B MoE Distill ')
  })

  it('keeps group and name when they differ', () => {
    expect(modelInfoTitle({ name: 'Qwen 3.8 27B Q5_K_M', group: 'Qwen 3.8 27B' })).toBe('Qwen 3.8 27B: Qwen 3.8 27B Q5_K_M')
  })

  it('without a group is the name, without a model is "Model"', () => {
    expect(modelInfoTitle({ name: 'GPT-OSS 120B' })).toBe('GPT-OSS 120B')
    expect(modelInfoTitle(null)).toBe('Model')
  })

  it('asks no platform: the function takes the model and nothing else', () => {
    expect(modelInfoTitle.length).toBe(1)
    const rule = readFileSync(resolve(__dirname, '../model-info-title.ts'), 'utf-8')
    expect(rule).not.toMatch(/isMacOS|isMlxImageHost|hostIsMac|mac:/)
  })

  it('is what the dialog uses', () => {
    const source = readFileSync(resolve(__dirname, '../../components/models/DiscoverModels.tsx'), 'utf-8')
    expect(source).toContain('title={modelInfoTitle(infoModel)}')
  })
})
