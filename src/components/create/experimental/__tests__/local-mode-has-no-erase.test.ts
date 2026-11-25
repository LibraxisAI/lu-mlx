/**
 * 3.1.3: Erase left local mode. An object goes through a mask in Edit, and
 * every way that still names Erase while local lands there with the source
 * and the mask. The cloud keeps its Erase tab as it was.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mlx = vi.hoisted(() => ({ host: false }))
vi.mock('../../../../api/mlx-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/mlx-image')>()),
  isMlxImageHost: () => mlx.host,
}))

import { INTENTS, INTENT_MAP, isIntentAvailable, pillEntries, visibleIntents } from '../intents'
import { needsMaskFor } from '../maskGate'
import { useCreateStore, type CreateState } from '../../../../stores/createStore'
import { intentToJob } from '../../../../lib/render/cloud-jobs'

const PICTURE = { filename: 'src.png', url: 'data:image/png;base64,x', width: 8, height: 8 }
const MASK = { filename: 'mask.png', url: 'data:image/png;base64,y', width: 8, height: 8 }
const QWEN = { name: 'MLX Qwen', type: 'qwenimage', editImages: 10 }
const TURBO = { name: 'MLX Turbo', type: 'unknown', editImages: 0 }
const store = () => useCreateStore.getState()
const models = (list: unknown[], pick: string) => useCreateStore.setState({ imageModelList: list, imageModel: pick } as never)

beforeEach(() => {
  mlx.host = false
  models([], '')
  useCreateStore.setState({ backend: 'local', source: null, mask: null })
  store().setIntent('image')
})

describe('Windows/Linux local mode hides Erase; macOS keeps local LaMa Erase', () => {
  const flags = [false, true]
  it('on Windows and Linux (non-Mac), Erase is hidden in local mode regardless of settings', () => {
    for (const features of flags) for (const installed of flags) {
      const list = visibleIntents('local', false, features, installed, installed, installed, installed, installed, installed, false)
      expect(list.map((m) => m.id)).not.toContain('eraser')
      expect(pillEntries(list).map((p) => p.meta.short)).not.toContain('Erase')
      expect(isIntentAvailable('eraser', 'local', false, installed, installed, installed, installed, installed, installed, false)).toBe(false)
    }
  })

  it('on macOS (both MLX-only and Comfy-connected), Erase stays available via LaMa', () => {
    for (const features of flags) for (const mlxHost of flags) {
      const list = visibleIntents('local', mlxHost, features, false, false, false, false, false, false, true)
      expect(list.map((m) => m.id)).toContain('eraser')
      expect(pillEntries(list).map((p) => p.meta.short)).toContain('Erase')
      expect(isIntentAvailable('eraser', 'local', mlxHost, false, false, false, false, false, false, true)).toBe(true)
    }
  })

  it('the Cloud sheet has no Erase card', () => {
    const sheet = readFileSync(resolve(__dirname, '../../../cloud/CloudTeaserModal.tsx'), 'utf8')
    expect(sheet).not.toMatch(/Erase|eraser/)
  })

  it('the local image tool sends an object to a mask in Edit', () => {
    for (const file of ['src/api/mcp/builtin-tools.ts', 'mobile-client/agent-core.js']) {
      const text = readFileSync(resolve(__dirname, '../../../../..', file), 'utf8')
      expect(text, file).not.toContain('upscale, erase')
      expect(text, file).toContain('a mask in Edit to repaint an area')
    }
  })
})

describe('a stored or sent Erase lands in Edit', () => {
  it('setIntent keeps the source and the mask', () => {
    useCreateStore.setState({ source: PICTURE, mask: MASK })
    store().setIntent('eraser')
    expect(store().intent()).toBe('edit')
    expect(store().utilityOp).toBeNull()
    expect(store().source).toEqual(PICTURE)
    expect(store().mask).toEqual(MASK)
  })

  it('on a Mac setIntent keeps Erase and its mask, even without an edit diffusion model', () => {
    mlx.host = true
    models([TURBO, QWEN], QWEN.name)
    useCreateStore.setState({ source: PICTURE, mask: MASK })
    store().setIntent('eraser')
    expect(store().intent()).toBe('eraser')
    expect(store().utilityOp).toBe('eraser')
    expect(store().mask).toEqual(MASK)

    models([TURBO], TURBO.name)
    store().setIntent('eraser')
    expect(store().intent()).toBe('eraser')
    expect(store().mask).toEqual(MASK)
  })

  it('the flip from Cloud keeps the source and the mask', () => {
    useCreateStore.setState({ backend: 'cloud' })
    store().setIntent('eraser')
    useCreateStore.setState({ source: PICTURE, mask: MASK })
    store().setBackend('local')
    expect(store().intent()).toBe('edit')
    expect(store().source).toEqual(PICTURE)
    expect(store().mask).toEqual(MASK)
  })

  it('the flip on a Mac keeps Erase, the source and the mask', () => {
    mlx.host = true
    models([TURBO, QWEN], TURBO.name)
    useCreateStore.setState({ backend: 'cloud' })
    store().setIntent('eraser')
    useCreateStore.setState({ source: PICTURE, mask: MASK })
    store().setBackend('local')
    expect(store().intent()).toBe('eraser')
    expect(store().source).toEqual(PICTURE)
    expect(store().mask).toEqual(MASK)
  })

  it('the flip on a Mac without an edit model still keeps Erase and its mask', () => {
    mlx.host = true
    models([TURBO], TURBO.name)
    useCreateStore.setState({ backend: 'cloud' })
    store().setIntent('eraser')
    useCreateStore.setState({ source: PICTURE, mask: MASK })
    store().setBackend('local')
    expect(store().intent()).toBe('eraser')
    expect(store().mask).toEqual(MASK)
  })

  it('a persisted blob with Erase opens on Edit on non-Mac and keeps Erase on Mac', () => {
    const merge = useCreateStore.persist.getOptions().merge!
    const merged = merge({ utilityOp: 'eraser', mode: 'video', imageSubMode: 'text2img' }, store()) as CreateState
    expect(merged.utilityOp).toBeNull()
    expect(merged.mode).toBe('image')
    expect(merged.imageSubMode).toBe('img2img')

    mlx.host = true
    const macMerged = merge({ utilityOp: 'eraser' }, store()) as CreateState
    expect(macMerged.utilityOp).toBe('eraser')
  })
})

describe('the cloud keeps Erase as it was', () => {
  it('the tab, its gate and its job', () => {
    expect(visibleIntents('cloud', false, true)).toEqual(INTENTS)
    expect(visibleIntents('cloud', true, false)).toEqual(INTENTS)
    expect(isIntentAvailable('eraser', 'cloud', true)).toBe(true)
    expect(INTENT_MAP.eraser).toMatchObject({ short: 'Erase', cloudOnly: true, needsPrompt: false, allowsMask: true })
    expect(needsMaskFor('eraser', 'cloud', undefined)).toBe(true)
    expect(intentToJob('eraser')).toEqual({ kind: 'image', op: 'eraser' })
  })

  it('setIntent stays on Erase with the source and the mask', () => {
    useCreateStore.setState({ backend: 'cloud', source: PICTURE, mask: MASK })
    store().setIntent('eraser')
    expect(store().intent()).toBe('eraser')
    expect(store().utilityOp).toBe('eraser')
    expect(store().mask).toEqual(MASK)
  })

  it('a stored Erase on the cloud track is not rewritten', () => {
    useCreateStore.setState({ backend: 'cloud' })
    const merge = useCreateStore.persist.getOptions().merge!
    const merged = merge({ utilityOp: 'eraser' }, store()) as CreateState
    expect(merged.utilityOp).toBe('eraser')
  })
})
