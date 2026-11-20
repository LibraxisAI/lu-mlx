// The web's lib/render/cloud-models.ts, as the mirrored Create in chat files
// see it, answered from the server's live catalogue (stores/cloudCatalogStore).
// The web's catalogue is a table in its bundle and names two fields in camel
// case; the desktop's rows come off the wire. This is the one place the two
// spellings meet.
import type { RenderKind, RenderOp } from '../../render/cloud-jobs'
import type { CloudModel as CatalogModel } from '../../render/cloud-models'
import * as catalog from '../../../stores/cloudCatalogStore'

export type CloudModel = CatalogModel & {
  lipsyncSource?: 'image' | 'video'
  supportsLyrics?: boolean
}

function row(m: CatalogModel): CloudModel {
  return { ...m, lipsyncSource: m.lipsync_source, supportsLyrics: m.lyrics }
}
const rows = (list: CatalogModel[]): CloudModel[] => list.map(row)

export function cloudModelById(id: string): CloudModel | undefined {
  const m = catalog.cloudModelById(id)
  return m && row(m)
}

/** The default model of a kind. The web's table always has one; a catalogue
 *  that carries none of a kind (never seen, the seed has all three) fails
 *  loudly here instead of sending a run without a model. */
export function defaultCloudModel(kind: RenderKind): CloudModel {
  const m = catalog.defaultCloudModel(kind)
  if (!m) throw new Error(`No ${kind} model is available right now.`)
  return row(m)
}

export const cloudModelsFor = (kind: RenderKind): CloudModel[] => rows(catalog.cloudModelsFor(kind))
export const opPickerModels = (op: RenderOp): CloudModel[] => rows(catalog.opPickerModels(op))
export const editCapableModels = (): CloudModel[] => rows(catalog.editCapableModels())
export const t2vModels = (): CloudModel[] => rows(catalog.t2vModels())
export const i2vModels = (): CloudModel[] => rows(catalog.i2vModels())

export const { editNeedsMask, modelForOp, resolveCharacterModel, resolveOpPick, utilityOpModel } = catalog
