/**
 * Discord 2026-10-01: downloads "mutated" into copies
 * of other renders. ComfyUI numbers a file one past the highest it still finds
 * for the prefix, and a gallery delete frees that number, so the next run with
 * the same prompt took the same name and a download of the older entry got the
 * newer picture. Each submitted run now carries its own tag in every prefix.
 *
 * Run: npx vitest run src/api/__tests__/every-run-writes-its-own-file-names.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { tagOutputPrefixes, newRunTag } from '../comfyui-graph'
import { submitWorkflow } from '../comfyui'
import { localFetch } from '../backend'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const graph: ComfyApiGraph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'juggernautXL.safetensors' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'red_apple_on_a_plate' } },
  '10': { class_type: 'VHS_VideoCombine', inputs: { images: ['8', 0], filename_prefix: 'red_apple__vid' } },
}

describe('the run tag', () => {
  it('goes on every output prefix and nowhere else', () => {
    const tagged = tagOutputPrefixes(graph, 'k3f9q2')
    expect(tagged['9']?.inputs?.filename_prefix).toBe('red_apple_on_a_plate_k3f9q2')
    expect(tagged['10']?.inputs?.filename_prefix).toBe('red_apple__vid_k3f9q2')
    expect(tagged['1']).toBe(graph['1'])
    // The caller's graph stays as built.
    expect(graph['9']?.inputs?.filename_prefix).toBe('red_apple_on_a_plate')
  })

  it('is six letters or digits, and two runs differ', () => {
    const a = newRunTag()
    expect(a).toMatch(/^[a-z0-9]{6}$/)
    expect(new Set(Array.from({ length: 50 }, newRunTag)).size).toBe(50)
  })
})

describe('submitting', () => {
  it('the same graph twice gives two different file names', async () => {
    const bodies: string[] = []
    vi.mocked(localFetch).mockImplementation(async (_url, opts) => {
      bodies.push(String(opts?.body))
      return new Response(JSON.stringify({ prompt_id: 'p' }), { status: 200 })
    })
    await submitWorkflow(graph)
    await submitWorkflow(graph)
    const prefixes = bodies.map((b) => JSON.parse(b).prompt['9'].inputs.filename_prefix as string)
    expect(prefixes[0]).toMatch(/^red_apple_on_a_plate_[a-z0-9]{6}$/)
    expect(prefixes[0]).not.toBe(prefixes[1])
  })
})
