/**
 * The box, 04.10.2026: under a cutout stood "512×512 · seed 697334996 · sd
 * turbo". A cutout has no seed and never ran on sd turbo.
 */
import { describe, it, expect } from 'vitest'

import { resultFacts } from '../result-facts'
import type { GalleryItem } from '../../../stores/createStore'

const item = (over: Partial<GalleryItem>): GalleryItem => ({
  id: 'x', type: 'image', filename: 'x.png', subfolder: '', prompt: '', negativePrompt: '',
  model: 'sd_turbo.safetensors', modelType: 'sd15', seed: 697334996, steps: 4, cfgScale: 1, sampler: '', scheduler: '',
  width: 512, height: 512, batchSize: 1, createdAt: 1, ...over,
})

describe('the line under a result', () => {
  it('a rendered image: size, seed, model', () => {
    expect(resultFacts(item({ intent: 'image' }))).toEqual(['512×512', 'seed 697334996', 'sd turbo'])
    expect(resultFacts(item({}))).toEqual(['512×512', 'seed 697334996', 'sd turbo'])
  })

  it('a cutout: its size and the cutout model, no seed, not the image model', () => {
    const facts = resultFacts(item({ intent: 'removebg', toolModel: 'RMBG-2.0', width: 768, height: 1024 }))
    expect(facts).toEqual(['768×1024', 'RMBG-2.0'])
  })

  it('a cutout from before the model was recorded, and a cloud cutout: the size alone', () => {
    expect(resultFacts(item({ intent: 'removebg' }))).toEqual(['512×512'])
    expect(resultFacts(item({ intent: 'removebg', jobId: 'j1', model: 'flux-schnell' }))).toEqual(['512×512'])
  })

  it('Enhance: no seed and not the image tab model', () => {
    expect(resultFacts(item({ intent: 'upscale', model: 'flux-schnell', width: 4096, height: 4096 }))).toEqual(['4096×4096'])
  })

  it('Erase: no seed and not the image tab model', () => {
    expect(resultFacts(item({ intent: 'eraser', model: 'flux-schnell' }))).toEqual(['512×512'])
  })

  it('audio: the model alone', () => {
    expect(resultFacts(item({ type: 'audio', model: 'ace_step_v1.safetensors' }))).toEqual(['ace step v1'])
  })
})
