import { describe, it, expect } from 'vitest'
import { INTENTS, INTENT_MAP, intentNeedsComfyGraph, isIntentAvailable, isIntentLocked, mlxOnlyCreateHost, visibleIntents } from '../intents'
import { LOCAL_LANE_OPS, LOCAL_UTILITY_OPS } from '../../../../stores/createStore'

// David 2026-07-10 made the advanced ops cloud-only; David 2026-07-12 brought
// Edit BACK to local as the 4th local tab (checkpoint mask inpaint —
// VAEEncodeForInpaint / InpaintModelConditioning); David 2026-07-17 brought
// Animate (local I2V) back as the 5th. 2.5.8 gives FOUR specialized categories
// REAL local lanes (hasLocalLane): music / lipsync / extend / motion on core
// ComfyUI node families (motion additionally needs the DWPose pack, which
// loads fine on Windows via the OpenCV CPU fallback). Upscale and eraser
// also have local ComfyUI lanes (ImageScale / inpaint). Character was
// cloud-first through 2.5.x; 2.6.0 ships the
// musubi trainer runtime (trainer.rs), so its train lane is local now too.
/** The pills the bar shows, in order. */
const shown = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost).map((m) => m.id)
/** The pills a user can actually select (no cloud-teaser lock). */
const unlocked = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost).filter((m) => !isIntentLocked(m, backend, mlxHost)).map((m) => m.id)
/** The pills shown as locked, cloud-tagged teasers. */
const teasers = (backend: 'local' | 'cloud', mlxHost: boolean) =>
  visibleIntents(backend, mlxHost).filter((m) => isIntentLocked(m, backend, mlxHost)).map((m) => m.id)

describe('intent cloud gating', () => {
  it('upscale and eraser have a local ComfyUI lane in the Mac fork only', () => {
    for (const id of ['upscale', 'eraser'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBe(true)
      expect(INTENT_MAP[id].localLaneMacOnly, id).toBe(true)
      // Windows/Linux: still the LU Cloud teaser (the local version is a
      // plain resize / checkpoint inpaint, weaker than the hosted tool).
      expect(isIntentLocked(INTENT_MAP[id], 'local', false), id).toBe(true)
      // Mac with its own ComfyUI connected (not MLX-only): a real local tab.
      expect(isIntentLocked(INTENT_MAP[id], 'local', false, true), id).toBe(false)
      expect(isIntentAvailable(id, 'local', false, true), id).toBe(true)
      expect(isIntentAvailable(id, 'local', false), id).toBe(false)
    }
  })

  it('image, edit, video, removebg and animate stay available locally', () => {
    for (const id of ['image', 'edit', 'video', 'removebg', 'animate'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBeUndefined()
    }
  })

  it('the dual lanes carry a hosted clip AND a local lane (character joined in 2.6.0)', () => {
    for (const id of ['music', 'lipsync', 'extend', 'motion', 'character'] as const) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
      expect(INTENT_MAP[id].hasLocalLane, id).toBe(true)
    }
  })

  it('intent metadata mirrors the store local-lane sets', () => {
    const fromMeta = INTENTS.filter((m) => m.hasLocalLane).map((m) => m.id).sort()
    expect(fromMeta).toEqual([...LOCAL_LANE_OPS, ...LOCAL_UTILITY_OPS].sort())
  })

  it('the local IntentBar filter keeps the classic tabs plus lanes selectable, utilities only on a Mac', () => {
    const everywhere = INTENTS.filter((m) => !m.cloudOnly || (m.hasLocalLane && !m.localLaneMacOnly)).map((m) => m.id)
    expect(everywhere).toEqual(['image', 'edit', 'removebg', 'video', 'animate', 'character', 'lipsync', 'music', 'extend', 'motion'])
    // Windows/Linux ComfyUI host
    expect(unlocked('local', false)).toEqual(everywhere)
    // Mac with ComfyUI connected also runs upscale / eraser locally
    const macComfy = INTENTS.filter((m) => !isIntentLocked(m, 'local', false, true)).map((m) => m.id)
    expect(macComfy).toEqual(['image', 'edit', 'removebg', 'upscale', 'eraser', 'video', 'animate', 'character', 'lipsync', 'music', 'extend', 'motion'])
  })

  it('local edit gates on the inpaint capability + image models', () => {
    expect(INTENT_MAP.edit.capability).toBe('inpaint-nodes')
    expect(INTENT_MAP.edit.requiresModels).toBe('image')
    expect(INTENT_MAP.edit.allowsMask).toBe(true)
    // The fresh-PC Download & install card also covers plain generation.
    expect(INTENT_MAP.image.requiresModels).toBe('image')
    expect(INTENT_MAP.video.requiresModels).toBe('video')
  })

  it('local animate needs a source image and gates on video models', () => {
    expect(INTENT_MAP.animate.needsSource).toBe(true)
    expect(INTENT_MAP.animate.isVideo).toBe(true)
    expect(INTENT_MAP.animate.requiresModels).toBe('video')
  })

  it('the lanes gate on their own model kinds', () => {
    expect(INTENT_MAP.music.requiresModels).toBe('audio')
    expect(INTENT_MAP.lipsync.requiresModels).toBe('lipsync')
    // Extend rides the regular i2v-capable video list (last-frame continue).
    expect(INTENT_MAP.extend.requiresModels).toBe('video')
    // Motion gates on the VACE/Animate model list AND the DWPose pack.
    expect(INTENT_MAP.motion.requiresModels).toBe('motion')
    expect(INTENT_MAP.motion.capability).toBe('dwpose')
    // Character has no requiresModels gate: LocalTrainControls runs its own
    // three gates (trainer env, Z-Image bases, staged photos) instead.
    expect(INTENT_MAP.character.requiresModels).toBeUndefined()
  })
})

// The Mac has NO spawned ComfyUI (connect-only): without a live instance
// local media is the in-process MLX path plus the musubi Character trainer.
// Every other lane's "local" implementation is a ComfyUI graph, so those
// stay locked teasers (or hidden when they have no hosted teaser sheet)
// until ComfyUI answers on :8080.
describe('intent gating on a local MLX Mac (no ComfyUI)', () => {
  it('image, video and character stay real local tabs', () => {
    expect(unlocked('local', true)).toEqual(['image', 'video', 'character'])
  })

  it('Comfy-backed hosted tools become cloud teasers until ComfyUI is connected', () => {
    expect(teasers('local', true)).toEqual(['upscale', 'eraser', 'lipsync', 'music', 'extend', 'motion'])
  })

  it('every Mac teaser has a cloud endpoint to teased about', () => {
    for (const id of teasers('local', true)) {
      expect(INTENT_MAP[id].cloudOnly, id).toBe(true)
    }
  })

  it('edit, removebg and animate are hidden rather than shown as dead tabs', () => {
    const hidden = INTENTS.map((m) => m.id).filter((id) => !shown('local', true).includes(id))
    expect(hidden).toEqual(['edit', 'removebg', 'animate'])
  })

  it('mlxOnlyCreateHost is the Mac switch: Comfy connected means not MLX-only', () => {
    expect(mlxOnlyCreateHost(true, false)).toBe(true)
    expect(mlxOnlyCreateHost(true, true)).toBe(false)
    expect(mlxOnlyCreateHost(false, false)).toBe(false)
    expect(unlocked('local', mlxOnlyCreateHost(true, true))).toEqual(unlocked('local', false))
    expect(intentNeedsComfyGraph('edit')).toBe(true)
    expect(intentNeedsComfyGraph('image')).toBe(false)
    expect(intentNeedsComfyGraph('character')).toBe(false)
  })

  it('nothing is hidden on cloud or on a ComfyUI local host', () => {
    expect(shown('cloud', true)).toEqual(INTENTS.map((m) => m.id))
    expect(shown('cloud', false)).toEqual(INTENTS.map((m) => m.id))
    expect(shown('local', false)).toEqual(INTENTS.map((m) => m.id))
  })

  it('cloud unlocks every intent regardless of host', () => {
    expect(unlocked('cloud', true)).toEqual(INTENTS.map((m) => m.id))
    expect(teasers('cloud', true)).toEqual([])
  })

  it('a Mac on the cloud backend is unaffected by the MLX rule', () => {
    expect(unlocked('cloud', true)).toEqual(unlocked('cloud', false))
  })

  it("isIntentAvailable gates the result's 'Edit with mask' action the same way", () => {
    // The action force-sets 'edit'; it must vanish exactly where the tab does.
    expect(isIntentAvailable('edit', 'local', true)).toBe(false)
    expect(isIntentAvailable('edit', 'local', false)).toBe(true)
    expect(isIntentAvailable('edit', 'cloud', true)).toBe(true)
    // And it agrees with the bar for every intent, on every backend/host.
    for (const backend of ['local', 'cloud'] as const) {
      for (const mlxHost of [true, false]) {
        for (const m of INTENTS) {
          expect(isIntentAvailable(m.id, backend, mlxHost), `${m.id}/${backend}/${mlxHost}`)
            .toBe(unlocked(backend, mlxHost).includes(m.id))
        }
      }
    }
  })
})
