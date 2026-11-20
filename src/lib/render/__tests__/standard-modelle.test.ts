// Standardmodelle fuer eine NEUE Auswahl (02.10.2026, Entscheid des Inhabers):
// Bild z-image-turbo, Bearbeiten qwen-image-2.1-edit, Video minimax-h3-t2v,
// Animate minimax-h3. Eine gespeicherte Wahl eines Kunden bleibt, wie sie ist.
//
// Desktop: die Standards gelten nur, wo der Server das Modell kennt. Ein
// aelterer Server (alterServer) kennt qwen-image-2.1-edit und minimax-h3-t2v
// nicht, dort faellt jede Stelle auf die erste Zeile ihres Waehlers zurueck,
// genau wie vor diesem Stand.

import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_IDS } from '../cloud-models'
import {
  animatePickerModels, classicDefaultModel, cloudModelById, defaultCloudModel, defaultEditModel, editCapableModels,
  modelForOp, useCloudCatalogStore, videoPickerModels,
} from '../../../stores/cloudCatalogStore'
import { useCreateStore } from '../../../stores/createStore'
import { STUDIO_MODELS } from '../studio-contract'
import { alterServer, neuerServer } from './fixtures/test-catalogs'

describe('mit dem Katalog des neuen Servers', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: neuerServer() }) })

  it('die vier Standardmodelle stehen im Katalog, sind offen und gehoeren in den Waehler ihrer Unterkategorie', () => {
    for (const id of Object.values(DEFAULT_MODEL_IDS)) {
      const m = cloudModelById(id)
      expect(m, id).toBeDefined()
      expect(m?.weights, id).toBe('open')
      expect(m?.tier, id).toBe('best')
    }
    expect(defaultCloudModel('image')?.id).toBe('z-image-turbo')
    expect(defaultCloudModel('video')?.id).toBe('minimax-h3-t2v')
    expect(defaultEditModel()?.id).toBe('qwen-image-2.1-edit')
    expect(editCapableModels().map((m) => m.id)).toContain(DEFAULT_MODEL_IDS.edit)
    expect(videoPickerModels().map((m) => m.id)).toContain(DEFAULT_MODEL_IDS.video)
    expect(animatePickerModels().map((m) => m.id)).toContain(DEFAULT_MODEL_IDS.animate)
    expect(STUDIO_MODELS['minimax-h3'].endpoint).toMatch(/image-to-video$/)
    expect(STUDIO_MODELS['minimax-h3-t2v'].endpoint).toMatch(/text-to-video$/)
  })

  it('ohne gespeicherte Wahl laeuft jede Unterkategorie auf ihrem Standard', () => {
    expect(modelForOp('image', 'generate', 'z-image-turbo')).toBe('z-image-turbo')
    expect(modelForOp('image', 'edit', '')).toBe('qwen-image-2.1-edit')
    expect(modelForOp('video', 'generate', '')).toBe('minimax-h3-t2v')
    expect(modelForOp('video', 'animate', '')).toBe('minimax-h3')
    expect(modelForOp('video', 'animate', 'minimax-h3-t2v')).toBe('minimax-h3')
    expect(modelForOp('video', 'generate', 'minimax-h3')).toBe('minimax-h3-t2v')
  })

  it('eine gespeicherte Wahl bleibt, wo sie gueltig ist', () => {
    expect(modelForOp('image', 'generate', 'flux-schnell')).toBe('flux-schnell')
    expect(modelForOp('image', 'edit', 'flux-dev')).toBe('flux-dev')
    expect(modelForOp('image', 'edit', 'qwen-image-edit')).toBe('qwen-image-edit')
    expect(modelForOp('video', 'generate', 'wan-2.2-720p')).toBe('wan-2.2-720p')
    expect(modelForOp('video', 'animate', 'wan-2.2-720p')).toBe('wan-2.2-720p')
    expect(modelForOp('video', 'animate', 'seedance-2.5')).toBe('seedance-2.5')
    expect(modelForOp('image', 'generate', 'qwen-image-2.1')).toBe('qwen-image-2.1')
  })

  it('Bild-Upscale bleibt wie er war', () => {
    expect(modelForOp('image', 'upscale', 'flux-schnell')).toBe('flux-schnell')
  })

  it('der klassische Standard bleibt ein klassisches Modell, ohne Studio-Eintrag', () => {
    for (const kind of ['image', 'video'] as const) {
      const m = classicDefaultModel(kind)!
      expect(m.ops, kind).toBeUndefined()
      expect(STUDIO_MODELS[m.id], kind).toBeUndefined()
    }
    expect(classicDefaultModel('image')?.id).toBe('flux-schnell')
    expect(classicDefaultModel('video')?.id).toBe('wan-2.2-720p')
  })
})

describe('eine gespeicherte Wahl uebersteht den Speicher', () => {
  it('der Waehler-Zustand schreibt keine Wahl um: wer gewaehlt hat, behaelt sie, wer nie gewaehlt hat, hat ""', () => {
    useCloudCatalogStore.setState({ models: neuerServer() })
    const st = useCreateStore.getState()
    st.setCloudImageModel('flux-schnell')
    st.setCloudVideoModel('wan-2.2-720p')
    expect(useCreateStore.getState().cloudImageModel).toBe('flux-schnell')
    expect(useCreateStore.getState().cloudVideoModel).toBe('wan-2.2-720p')
    // Die Aufloesung biegt die Wahl nur fuer den Lauf um, nie im Speicher.
    expect(modelForOp('image', 'generate', useCreateStore.getState().cloudImageModel)).toBe('flux-schnell')
    expect(useCreateStore.getState().cloudImageModel).toBe('flux-schnell')
    st.setCloudImageModel('')
    st.setCloudVideoModel('')
    expect(useCreateStore.getState().cloudImageModel).toBe('')
    expect(modelForOp('image', 'generate', '')).toBe('z-image-turbo')
  })
})

describe('mit dem Katalog des alten Servers (vor dem 02.10.2026)', () => {
  beforeEach(() => { useCloudCatalogStore.setState({ models: alterServer() }) })

  it('fehlende Standards fallen auf die erste Zeile des Waehlers zurueck, bekannte gelten', () => {
    // z-image-turbo und minimax-h3 kannte der alte Server schon.
    expect(defaultCloudModel('image')?.id).toBe('z-image-turbo')
    expect(modelForOp('video', 'animate', '')).toBe('minimax-h3')
    // qwen-image-2.1-edit und minimax-h3-t2v nicht: es bleibt wie vor dem Stand.
    expect(cloudModelById('qwen-image-2.1-edit')).toBeUndefined()
    expect(cloudModelById('minimax-h3-t2v')).toBeUndefined()
    expect(defaultCloudModel('video')?.id).toBe('wan-2.2-720p')
    expect(modelForOp('video', 'generate', '')).toBe('wan-2.2-720p')
    expect(defaultEditModel()?.id).toBe('flux-dev')
    expect(modelForOp('image', 'edit', '')).toBe('flux-dev')
  })

  it('eine Wahl, die der alte Server nicht kennt, faellt auf den Standard, statt zu scheitern', () => {
    expect(modelForOp('image', 'edit', 'qwen-image-2.1-edit')).toBe('flux-dev')
    expect(modelForOp('video', 'generate', 'minimax-h3-t2v')).toBe('wan-2.2-720p')
    expect(modelForOp('image', 'generate', 'qwen-image-2.1')).toBe('z-image-turbo')
  })
})
