// Wie die Cloud-Waehler Modelle ordnen und kennzeichnen (02.10.2026).
//
// Die Stufe ordnet, sie versteckt nichts: 'best' steht oben und traegt eine
// kleine Marke, 'older' steht gesammelt unten unter einer Zwischenzeile, alles
// dazwischen behaelt seine Reihenfolge. Seit dem 05.10.2026 stehen die
// Cloud-Modelle dabei in Familien (groupForPicker). Die Herkunft steht dezent daneben,
// sobald die Familie offene Gewichte hat. Diese Datei ist rein und kennt keine
// Oberflaeche, damit ModelChip und PresetWorkshop dieselbe Regel benutzen und
// ein Test sie festhalten kann.
//
// Desktop-Unterschied zum Web: dort tragen alle Modelle beide Felder, weil der
// Katalog im selben Repo liegt. Der Desktop liest den Katalog vom Server, und
// ein aelterer Server liefert die Felder nicht. Ein Modell ohne `tier` gilt
// darum als 'standard' und eines ohne `weights` als 'closed' ohne Marke: es
// steht in seiner gewohnten Reihenfolge und traegt nichts. Lokale ComfyUI-
// Modelle haben noch keine Stufe und laufen durch dieselben Regeln.

import type { ModelTier, ModelWeights } from './studio-contract'

export type { ModelTier, ModelWeights }

/** Die Zwischenzeile ueber den aelteren Modellen. */
export const OLDER_GROUP = 'Older models'

const RANK: Record<ModelTier, number> = { best: 0, standard: 1, older: 2 }

const TIERS: readonly string[] = ['best', 'standard', 'older']
const WEIGHTS: readonly string[] = ['open', 'open-family', 'closed']

/** Die Felder, die ein Modell tragen KANN. Fehlt eines, gilt es als neutral. */
export interface TierFields { tier?: ModelTier; weights?: ModelWeights }

/** Jedes Modell darf in diese Funktionen, auch eines, das die Felder gar nicht
 *  kennt (ein lokales ComfyUI-Modell): `object` statt `TierFields`, weil TypeScript
 *  einen Typ aus lauter optionalen Feldern fuer Objekte ohne eines davon ablehnt. */
type Tiered = object

function fields(m: Tiered): TierFields {
  return m as TierFields
}

/** Die Stufe, mit der ein Modell sortiert wird. Unbekannt oder fehlend: 'standard'. */
export function tierOf(m: Tiered): ModelTier {
  const tier = fields(m).tier
  return typeof tier === 'string' && TIERS.includes(tier) ? tier : 'standard'
}

/** Die Herkunft eines Modells. Unbekannt oder fehlend: 'closed', also keine Marke. */
export function weightsOf(m: Tiered): ModelWeights {
  const weights = fields(m).weights
  return typeof weights === 'string' && WEIGHTS.includes(weights) ? weights : 'closed'
}

/** Stabil: Modelle gleicher Stufe behalten ihre Reihenfolge, damit eine
 *  gewohnte Liste nicht durcheinanderfaellt. Die Eingabe bleibt unberuehrt. */
export function sortByTier<T extends Tiered>(list: readonly T[]): T[] {
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => RANK[tierOf(a.m)] - RANK[tierOf(b.m)] || a.i - b.i)
    .map(({ m }) => m)
}

/** Die Zwischenzeile, unter der ein Modell steht. Nur 'older' hat eine. */
export function tierGroup(m: Tiered): string | undefined {
  return tierOf(m) === 'older' ? OLDER_GROUP : undefined
}

/** Alles ohne eigene Familie, die letzte Gruppe vor den Aelteren. */
export const OTHER_GROUP = 'Other'

/**
 * Die Familie eines Medienmodells, aus seinem Namen gelesen: das erste Wort
 * ohne Versionsanhang. "FLUX 3 Upscale", "Flux Schnell (fast)" und "Flux 2 Dev" sind
 * Flux, "Qwen3 TTS" und "Qwen Image" sind Qwen, "LTX-2" und "LTX 2.5" sind LTX.
 * Verglichen wird ohne Gross- und Kleinschreibung.
 */
export function mediaFamily(label: string): string {
  const first = label.trim().split(/[\s(]/)[0] ?? ''
  const base = first.replace(/[-.]?\d[\w.]*$/, '') || first
  return /^hunyuan/i.test(base) ? 'Hunyuan' : base
}

/**
 * Die Liste eines Cloud-Waehlers, in Reihenfolge und mit Gruppenkopf.
 *
 * 05.10.2026: die Waehler in Create gruppieren die Cloud-Modelle nach
 * Familie, mit denselben einzeiligen Koepfen wie die Modellauswahl im Chat.
 * Das trifft auf den Entscheid vom 02.10. (Beste oben, Aeltere gesammelt
 * unten). Beides gilt so zusammen, wie im Web:
 *  - 'older' bleibt gesammelt am Ende unter "Older models", nichts verschwindet.
 *  - Davor stehen die Familien. Eine Familie steht dort, wo ihr bestes Modell
 *    in der Stufenordnung steht, also fuehren die Familien mit einem "Best".
 *  - In jeder Gruppe bleibt die Stufenordnung: Beste zuerst.
 *  - Eine Familie mit einem einzigen Modell bekommt keinen eigenen Kopf, sie
 *    steht unter "Other", zuletzt vor den Aelteren. Ein Kopf ueber einer Zeile
 *    sagt nur, was die Zeile schon sagt.
 *  - Gibt es danach nur eine einzige Gruppe, entfaellt der Kopf ganz.
 *
 * Nur fuer Cloud-Listen. Lokale Modelle bleiben in ihrer Ordnung (sortByTier
 * und tierGroup).
 */
export function groupForPicker<T extends { label: string }>(
  list: readonly T[],
): { model: T; group: string | undefined }[] {
  const sorted = sortByTier(list)
  const current = sorted.filter((m) => tierOf(m) !== 'older')
  const key = (m: T) => mediaFamily(m.label).toLowerCase()
  const size = new Map<string, number>()
  for (const m of current) size.set(key(m), (size.get(key(m)) ?? 0) + 1)
  // Der Kopf traegt die Schreibweise des ersten Modells der Familie.
  const name = new Map<string, string>()
  for (const m of current) if (!name.has(key(m))) name.set(key(m), mediaFamily(m.label))
  const groupOf = (m: T) => ((size.get(key(m)) ?? 0) > 1 ? name.get(key(m))! : OTHER_GROUP)

  const order: string[] = []
  for (const m of current) if (groupOf(m) !== OTHER_GROUP && !order.includes(groupOf(m))) order.push(groupOf(m))
  if (current.some((m) => groupOf(m) === OTHER_GROUP)) order.push(OTHER_GROUP)
  const older = sorted.filter((m) => tierOf(m) === 'older')
  const heads = order.length + (older.length ? 1 : 0) > 1

  return [
    ...order.flatMap((group) => current.filter((m) => groupOf(m) === group)
      .map((model) => ({ model, group: heads ? group : undefined }))),
    ...older.map((model) => ({ model, group: tierGroup(model) })),
  ]
}

/** 'accent' ist der eine Akzent der Waehler, ohne Ton steht die Marke grau. */
export interface TierMark { label: string; tone?: 'accent' }

/** Die Marken eines Modells, in der Reihenfolge, in der sie stehen.
 *  'open' sagt "Open weights": genau diese Version hat offene Gewichte.
 *  'open-family' sagt "Open family": die Familie hat welche, diese Version nicht.
 *  Beides ehrlich getrennt, damit "Open weights" nie mehr verspricht, als stimmt.
 *  Ohne Felder gibt es keine Marke. */
export function tierMarks(m: Tiered): TierMark[] {
  const marks: TierMark[] = []
  if (tierOf(m) === 'best') marks.push({ label: 'Best', tone: 'accent' })
  if (weightsOf(m) === 'open') marks.push({ label: 'Open weights' })
  if (weightsOf(m) === 'open-family') marks.push({ label: 'Open family' })
  return marks
}
