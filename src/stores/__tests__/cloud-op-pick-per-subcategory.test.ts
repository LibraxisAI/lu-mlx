/**
 * Jede Unterkategorie behaelt ihre eigene Modellwahl (Opus-Endpruefung
 * 02.10.2026). cloudOpModel war ein gemeinsamer Platz fuer Lipsync, Musik,
 * Verlaengern und Motion: eine Wahl in einer Unterkategorie loeschte die Wahl
 * der anderen. Die Wahl ist nur Laufzeitzustand (nicht gespeichert), also gibt es
 * keine gespeicherte Wahl, die zu migrieren waere.
 *
 * Run: npx vitest run src/stores/__tests__/cloud-op-pick-per-subcategory.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCreateStore, opSlot } from '../createStore'

const st = () => useCreateStore.getState()

beforeEach(() => {
  useCreateStore.setState({ cloudOpModel: '', cloudOpPicks: {}, cloudOp: null, utilityOp: null, removebg: false, mode: 'image', imageSubMode: 'text2img', videoSubMode: 't2v', characterTab: 'train' })
})

describe('die Wahl je Unterkategorie', () => {
  it('Lip Sync loescht die Musikwahl nicht', () => {
    st().setIntent('music')
    st().setCloudOpModel('music-model-a')
    st().setIntent('lipsync')
    expect(st().cloudOpModel).toBe('')           // Lip Sync hat noch keine eigene Wahl
    st().setCloudOpModel('lipsync-model-b')
    expect(st().cloudOpModel).toBe('lipsync-model-b')
    st().setIntent('music')
    expect(st().cloudOpModel).toBe('music-model-a')
    st().setIntent('lipsync')
    expect(st().cloudOpModel).toBe('lipsync-model-b')
  })

  it('Lipsync, Musik, Verlaengern und Motion halten je ihre Wahl', () => {
    const picks: Record<string, string> = { lipsync: 'l-1', music: 'm-1', extend: 'e-1', motion: 'mo-1' }
    for (const [intent, id] of Object.entries(picks)) {
      st().setIntent(intent as never)
      st().setCloudOpModel(id)
    }
    for (const [intent, id] of Object.entries(picks)) {
      st().setIntent(intent as never)
      expect(st().cloudOpModel, intent).toBe(id)
    }
  })

  it('eine Wahl, die ohne setter geschrieben wird (setState), gehoert der aktuellen Unterkategorie', () => {
    st().setIntent('music')
    useCreateStore.setState({ cloudOpModel: 'direct-pick' })
    st().setIntent('lipsync')
    expect(st().cloudOpModel).toBe('')
    st().setIntent('music')
    expect(st().cloudOpModel).toBe('direct-pick')
  })

  it('Character Studio: Trainieren und Benutzen sind zwei Plaetze', () => {
    st().setIntent('character')
    st().setCloudOpModel('trainer-x')
    st().setCharacterTab('use')
    expect(opSlot(st())).toBe('character:use')
    expect(st().cloudOpModel).toBe('')
    st().setCloudOpModel('gen-y')
    st().setCharacterTab('train')
    expect(st().cloudOpModel).toBe('trainer-x')
  })

  it('der Wechsel zwischen Unterkategorien verliert keine Wahl, auch ueber Video und Bild hinweg', () => {
    st().setIntent('lipsync')
    st().setCloudOpModel('l-1')
    st().setIntent('video')
    st().setIntent('image')
    st().setIntent('lipsync')
    expect(st().cloudOpModel).toBe('l-1')
  })
})
