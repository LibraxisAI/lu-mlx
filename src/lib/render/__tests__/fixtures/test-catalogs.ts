// Zwei Kataloge fuer die Tests des Cloud-Modus.
//
// Der Desktop liest seinen Katalog vom Server (`/api/jobs/catalog?v=2`). Wie er
// aussieht, haengt davon ab, welcher Server antwortet:
//
//  - neuerServer: der Stand ab 02.10.2026. Jedes Studio-Modell der mitgelieferten
//    Registrierung steht im Katalog, mit `tier`, `weights` und `quote_required`.
//    Genau das schickt der Server (the web app) fuer
//    die Eintraege aus CLOUD_MODELS.
//  - alterServer: der Stand VOR dem 02.10.2026 (Produktion bis zum Deploy). Die
//    Modelle sind die Ids aus katalog-vor-02-10-2026.json, die der Web-Stand
//    293578b2 geliefert hat, und kein Eintrag traegt `tier` oder `weights`.
//
// Beide sind Funktionen, kein geteilter Wert: ein Test aendert den Katalog und
// darf keinem anderen etwas hinterlassen.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOUD_MODEL_SEED, type CloudModel } from '../../cloud-models'
import { STUDIO_MODELS } from '../../studio-contract'

function studioEintrag(id: string, mitStufe: boolean): CloudModel {
  const m = STUDIO_MODELS[id]
  return {
    id,
    label: m.label,
    kind: m.kind,
    adult: m.adult,
    ops: ['studio'],
    quote_required: true,
    ...(mitStufe ? { tier: m.tier, weights: m.weights } : {}),
  }
}

/** Die Eintraege des Notvorrats ohne Stufe und Herkunft, wie ein alter Server sie liefert. */
function ohneStufe(m: CloudModel): CloudModel {
  const { tier: _tier, weights: _weights, ...rest } = m
  void _tier
  void _weights
  return rest
}

/** Der Katalog ab 02.10.2026: Notvorrat plus jedes Studio-Modell, mit Stufe und Herkunft. */
export function neuerServer(): CloudModel[] {
  return [
    ...Object.keys(STUDIO_MODELS).map((id) => studioEintrag(id, true)),
    ...CLOUD_MODEL_SEED.map((m) => ({ ...m })),
  ]
}

const ALT_IDS = JSON.parse(
  readFileSync(join(__dirname, 'katalog-vor-02-10-2026.json'), 'utf8'),
) as string[]

/** Der Katalog VOR dem 02.10.2026: nur die damaligen Ids, keine Stufe, keine Herkunft. */
export function alterServer(): CloudModel[] {
  const seed = new Map(CLOUD_MODEL_SEED.map((m) => [m.id, m]))
  const out: CloudModel[] = []
  for (const id of ALT_IDS) {
    const klassisch = seed.get(id)
    if (klassisch) out.push(ohneStufe(klassisch))
    else if (STUDIO_MODELS[id]) out.push(studioEintrag(id, false))
  }
  return out
}

/** Ids, die der Stand 02.10.2026 NEU im Katalog fuehrt und ein alter Server nicht kennt. */
export function neueIds(): string[] {
  const alt = new Set(ALT_IDS)
  return Object.keys(STUDIO_MODELS).filter((id) => !alt.has(id))
}
