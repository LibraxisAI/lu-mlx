/**
 * Wan 2.2 I2V A14B reads its start image as input channels. Called from text
 * alone, the engine loads two 14B experts and then fails on a tensor shape.
 *
 * The chat tool has to notice before that: with no model named it picks one
 * that runs from text, and with the image to video model named and no image
 * it answers in words and starts nothing.
 *
 * Lauf: npx vitest run src/api/mcp/__tests__/mac-video-tool-image-required.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MCPToolDefinition, ToolArgs } from '../types'
import type { ToolRegistry } from '../tool-registry'

const started: Array<{ id: string; initImage?: string }> = []
const catalog = [
  { id: 'wan22-i2v-a14b', name: 'Wan 2.2 I2V A14B', family: 'wan_2', installed: true, requiresImage: true },
  { id: 'wan21-t2v-1.3b', name: 'Wan 2.1 T2V 1.3B', family: 'wan_2', installed: true, requiresImage: false },
]

vi.mock('../../mlx-image', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  isMlxImageHost: () => true,
}))
vi.mock('../../mlx-video', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getVideoStatus: vi.fn(async () => ({ available: true, mlxInstalled: true, installedModels: catalog.map((m) => m.id) })),
  listVideoModels: vi.fn(async () => catalog),
  generateVideo: vi.fn(async (p: { id: string; initImage?: string }) => {
    started.push({ id: p.id, initImage: p.initImage })
    throw new Error('stop here')
  }),
}))

type Executor = (args: ToolArgs) => Promise<string>

async function videoTool(): Promise<Executor> {
  const { registerBuiltinTools } = await import('../builtin-tools')
  const found: Record<string, Executor> = {}
  registerBuiltinTools({
    registerBuiltin: (tool: MCPToolDefinition, run: Executor) => { found[tool.name] = run },
    // The Create tools of the cloud chat are registered and withdrawn again
    // at start (create-tools.ts, reserveCreateTools).
    withdrawBuiltin: (name: string) => { delete found[name] },
    setRetiredRunner: () => {},
  } as unknown as ToolRegistry)
  return found.video_generate
}

describe('the Mac video tool and a model that needs a start image', () => {
  beforeEach(() => { started.length = 0 })

  it('picks a text to video model when no model and no image are given', async () => {
    const run = await videoTool()
    await run({ prompt: 'clouds over a lake' })
    expect(started).toEqual([{ id: 'wan21-t2v-1.3b', initImage: undefined }])
  })

  it('refuses the image to video model without an image, and names the way out', async () => {
    const run = await videoTool()
    const out = await run({ prompt: 'clouds over a lake', model: 'Wan 2.2 I2V A14B' })
    expect(started).toEqual([])
    expect(out).toContain('turns a start image into video and cannot run from text alone')
    expect(out).toContain('inputImage')
    expect(out).toContain('Wan 2.1 T2V 1.3B')
  })

  it('starts it once an image is there', async () => {
    const run = await videoTool()
    await run({ prompt: 'clouds over a lake', model: 'Wan 2.2 I2V A14B', inputImage: '/tmp/start.png' })
    expect(started).toEqual([{ id: 'wan22-i2v-a14b', initImage: '/tmp/start.png' }])
  })
})
