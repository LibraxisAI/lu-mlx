// The one place that decides which face the Model Manager wears.
//
// 08.10.2026: "Das neue Model-Manager-Design soll ausschliesslich fuer
// den Mac sein. Auf Windows gefaellt mir das genauso, wie es gerade ist."
//
// So there are two faces. `mac` is the redesign of 08.10.2026, `classic` is
// the page as it stood before it, and Windows and Linux keep that one. The
// rules of the page (download, install, catalogues, file resolution, the
// platform filter of the chat catalogue) do not know about this file: they
// exist once and both faces show their result.
//
// Nothing else asks the platform in order to pick a look. A component that
// needs the answer calls `modelSkinName()` here or takes `modelSkin()` from
// ./index, which is built on it.
import { isMacOS } from '../../../api/backend'

export type ModelSkinName = 'classic' | 'mac'

export function modelSkinName(): ModelSkinName {
  return isMacOS() ? 'mac' : 'classic'
}
