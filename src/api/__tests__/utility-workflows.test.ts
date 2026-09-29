import { describe, it, expect } from 'vitest'
import { buildLocalUpscaleWorkflow } from '../utility-workflows'

describe('buildLocalUpscaleWorkflow', () => {
  it('is LoadImage → ImageScale (lanczos) → SaveImage', () => {
    const wf = buildLocalUpscaleWorkflow('source.png', 2048, 1536)
    expect(wf['1']?.class_type).toBe('LoadImage')
    expect(wf['1']?.inputs?.image).toBe('source.png')
    expect(wf['2']?.class_type).toBe('ImageScale')
    expect(wf['2']?.inputs?.image).toEqual(['1', 0])
    expect(wf['2']?.inputs?.upscale_method).toBe('lanczos')
    expect(wf['2']?.inputs?.width).toBe(2048)
    expect(wf['2']?.inputs?.height).toBe(1536)
    expect(wf['2']?.inputs?.crop).toBe('disabled')
    expect(wf['3']?.class_type).toBe('SaveImage')
    expect(wf['3']?.inputs?.images).toEqual(['2', 0])
    expect(wf['3']?.inputs?.filename_prefix).toBe('LU_upscale')
  })

  it('floors size and never emits a zero dimension', () => {
    const wf = buildLocalUpscaleWorkflow('a.png', 0.4, -3)
    expect(wf['2']?.inputs?.width).toBe(1)
    expect(wf['2']?.inputs?.height).toBe(1)
  })
})
