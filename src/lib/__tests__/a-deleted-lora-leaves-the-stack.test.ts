/**
 * GH #146 (2026-10-01): LoRAs deleted from models/loras stayed in
 * the persisted stack, showed as "2 active" with nothing ticked, and every run
 * sent them until ComfyUI refused the graph. One was a Z-Image character that
 * rode into the Animate lane.
 *
 * Run: npx vitest run src/lib/__tests__/a-deleted-lora-leaves-the-stack.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { lorasForRun, loraFitsModel, skippedLorasLine } from '../lora-stack'
import { useCreateStore } from '../../stores/createStore'
import { readFileSync } from 'node:fs'

const GONE = 'char_gracechar_e110.safetensors'
const CHAR = 'char_gracechar_zimage.safetensors'
const STYLE = 'film_grain_xl.safetensors'
const pick = (name: string, strength = 0.8) => ({ name, strength })

describe('what a run sends', () => {
  it('leaves out a file ComfyUI no longer lists', () => {
    const r = lorasForRun([pick(GONE), pick(STYLE)], [STYLE], 'sdxl')
    expect(r.use).toEqual([pick(STYLE)])
    expect(r.missing).toEqual([GONE])
  })

  it('sends a Z-Image character only to a Z-Image model', () => {
    expect(loraFitsModel(CHAR, 'zimage')).toBe(true)
    expect(loraFitsModel(CHAR, 'wan22')).toBe(false)
    expect(loraFitsModel('loras/sub/char_mira_zimage.safetensors', 'sdxl')).toBe(false)
    expect(loraFitsModel(STYLE, 'wan22')).toBe(true)
    const r = lorasForRun([pick(CHAR), pick(STYLE)], [CHAR, STYLE], 'wan22')
    expect(r.use).toEqual([pick(STYLE)])
    expect(r.otherModel).toEqual([CHAR])
  })

  // Negative control: an unreachable ComfyUI is no proof a file is gone.
  it('keeps every pick when the list could not be read', () => {
    const r = lorasForRun([pick(GONE), pick(STYLE)], null, 'sdxl')
    expect(r.use).toEqual([pick(GONE), pick(STYLE)])
    expect(r.missing).toEqual([])
  })

  it('says in one line what it skipped, and nothing when it skipped nothing', () => {
    expect(skippedLorasLine([GONE], [CHAR])).toBe('Skipping LoRA no longer in models/loras: char_gracechar_e110; Z-Image characters only: char_gracechar_zimage')
    expect(skippedLorasLine([], [])).toBeNull()
  })
})

describe('the stack follows the folder', () => {
  beforeEach(() => {
    useCreateStore.setState({
      selectedLoras: [pick(GONE), pick(CHAR, 1.5), pick(STYLE)],
      selectedCharacter: { id: `local:${CHAR}`, name: 'gracechar', triggerWord: 'gracechar', family: 'z-image' },
    })
  })

  it('a rescan drops picks whose file is gone, and the character that rode on one', () => {
    useCreateStore.getState().keepListedLoras([STYLE])
    expect(useCreateStore.getState().selectedLoras).toEqual([pick(STYLE)])
    expect(useCreateStore.getState().selectedCharacter).toBeNull()
  })

  it('a character whose file is still there stays picked', () => {
    useCreateStore.getState().keepListedLoras([CHAR, STYLE])
    expect(useCreateStore.getState().selectedLoras.map((l) => l.name)).toEqual([CHAR, STYLE])
    expect(useCreateStore.getState().selectedCharacter?.id).toBe(`local:${CHAR}`)
  })

  it('Clear empties the stack and lets go of the local character', () => {
    useCreateStore.getState().clearLoras()
    expect(useCreateStore.getState().selectedLoras).toEqual([])
    expect(useCreateStore.getState().selectedCharacter).toBeNull()
  })
})

describe('the result keeps the skip line (Gegenprobe 8, 02.10.)', () => {
  it('every ComfyUI result written after the LoRA check carries the note', () => {
    const src = readFileSync('src/hooks/useCreate.ts', 'utf8')
    const after = src.slice(src.indexOf('let skippedNote'))
    const adds = after.match(/addToGallery\(\{/g) ?? []
    const notes = after.match(/\.\.\.\(skippedNote \? \{ runNote: skippedNote \} : \{\}\)/g) ?? []
    expect(adds.length).toBeGreaterThan(0)
    expect(notes.length).toBe(adds.length)
  })
})
