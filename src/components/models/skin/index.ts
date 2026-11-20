// The two faces of the Model Manager and the one line that picks between
// them. The decision itself stands in ./which.ts; this file only hands out
// the face that goes with it.
import { classicSkin } from './classic'
import { macSkin } from './mac'
import { modelSkinName } from './which'
import type { ModelSkin } from './types'

export function modelSkin(): ModelSkin {
  return modelSkinName() === 'mac' ? macSkin : classicSkin
}

export type { ModelSkin, RailEntry, RailKey, ModelsTab } from './types'
