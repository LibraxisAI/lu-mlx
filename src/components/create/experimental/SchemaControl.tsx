// Ein Bedienelement aus einem Anbieterschema.
//
// 19.09.2026 aus PresetWorkshop herausgeloest: seit die Unterkategorien von
// Create ebenfalls Studio-Modelle fahren, brauchen beide Oberflaechen genau
// dieselben Felder. Zwei Abschriften waeren zwei Wahrheiten darueber, welcher
// Regler welchen Wert schickt.
//
// 19.09.2026, Befund vom Inhaber zu Extend Video, Motion Control und Enhance
// Video: "viel zu fett, viel zu haesslich ... als haette man sich da gar keine
// Gedanken drueber gemacht". Das lag nicht an der Klappe, sondern hieran: eine
// Zahl mit einer Stelle und eine Liste mit vier Werten standen in Feldern ueber
// die volle Breite, untereinander weg, ohne Gruppe und ohne Rhythmus. Die
// Elemente bleiben, was sie sind - ein select bleibt ein select -, aber Hoehe,
// Rahmen und Schrift kommen jetzt aus denselben Marken wie der Rest der
// Oberflaeche, und wer wenig Platz braucht, bekommt eine halbe Zeile.

import { studioFields, studioSchema, type Schema } from '../../../lib/render/studio-contract'
import { AvatarPicker } from './AvatarPicker'
import { avatarPreview } from '../../../lib/render/heygen-avatars'
import { Dices } from 'lucide-react'
import { cn } from '../ui/cn'

export const baseFieldClass =
  'w-full h-[var(--control-h-md)] rounded-[var(--radius-control)] border border-white/[0.08] bg-white/[0.04] px-2.5 t-control text-gray-200 outline-none transition-colors focus:border-white/25'

export function label(name: string): string {
  return name.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
}

/** Die Felder in der Reihenfolge, die der Anbieter selbst vorsieht. Sein
 *  Schema traegt sie in `x-order-properties`; ohne die stehen sie so da, wie
 *  JSON sie zufaellig sortiert hat, und bei HeyGen kaeme die Ausgabegroesse vor
 *  dem Presenter. Felder ohne Rang haengen hinten an. */
export function studioFieldsInOrder(model: string): [string, Schema][] {
  const wunsch = (studioSchema(model) as { 'x-order-properties'?: unknown })['x-order-properties']
  const reihe = Array.isArray(wunsch) ? wunsch.map(String) : []
  const rang = (key: string) => {
    const i = reihe.indexOf(key)
    return i === -1 ? reihe.length : i
  }
  return Object.entries(studioFields(model)).sort((a, b) => rang(a[0]) - rang(b[0]))
}

/** Ob das Feld mit einer halben Zeile auskommt. Eine Zahl, ein Schalter und
 *  eine kurze Liste tun das; ein freier Text nie. */
export function isCompactField(schema: Schema): boolean {
  if (schema.type === 'boolean') return true
  if (schema.type === 'integer' || schema.type === 'number') return true
  if (schema.enum) return schema.enum.every((v) => String(v).length <= 12)
  return false
}

function Feldname({ text }: { text: string }) {
  return <span className="t-control text-gray-400">{text}</span>
}

export function SchemaControl({ name, schema, value, onChange, disabled, className, title }: {
  name: string; schema: Schema; value: unknown; onChange: (v: unknown) => void; disabled: boolean; className?: string
  /** What the field is called where the schema's own name misleads. */
  title?: string
}) {
  const fieldClass = className ?? baseFieldClass
  const current = value ?? schema.default ?? (schema.type === 'boolean' ? false : '')
  const titel = title ?? (name === 'preset' ? 'Style preset' : label(name))

  if (schema.type === 'array' && name === 'loras') {
    const rows = (Array.isArray(value) ? value : []) as { path: string; scale?: number }[]
    const choices = schema.items?.properties?.path?.enum ?? []
    return (
      <fieldset className="space-y-2">
        <legend className="mb-1 t-control text-gray-500">Style LoRAs · up to {schema.maxItems ?? 3}</legend>
        {rows.map((row, i) => (
          <div key={i} className="space-y-1.5 rounded-[var(--radius-control)] border border-white/[0.08] p-2">
            <select aria-label={`LoRA ${i + 1}`} title={row.path} disabled={disabled} className={fieldClass} value={row.path}
              onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}>
              {choices.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
            </select>
            <div className="flex items-end gap-2">
              <label className="flex-1 space-y-1.5">
                <Feldname text="Strength" />
                <input aria-label={`LoRA ${i + 1} strength`} type="number" step="0.1" disabled={disabled} className={fieldClass}
                  value={row.scale ?? 1} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, scale: Number(e.target.value) } : x)))} />
              </label>
              <button disabled={disabled} aria-label={`Remove LoRA ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="h-[var(--control-h-md)] px-2 t-control text-gray-500 transition-colors hover:text-gray-300">Remove</button>
            </div>
          </div>
        ))}
        {rows.length < (schema.maxItems ?? 3) && (
          <button disabled={disabled} className="t-control text-lu-accent"
            onClick={() => onChange([...rows, { path: String(choices.find((v) => !rows.some((r) => r.path === v)) ?? choices[0]), scale: 1 }])}>
            + Add style LoRA
          </button>
        )}
      </fieldset>
    )
  }
  if (schema.type === 'array' || schema.type === 'object') return null

  // Der Presenter ist ein Gesicht, kein Wort. Eine Liste mit 500 Namen laesst
  // den Kunden raten und fuer das Raten zahlen, also stehen hier Kacheln.
  if (name === 'avatar' && Array.isArray(schema.enum) && schema.enum.some((v) => avatarPreview(String(v)))) {
    return (
      <div className="space-y-1.5">
        <Feldname text="Presenter" />
        <AvatarPicker names={schema.enum.map(String)} value={String(current)} onChange={onChange} disabled={disabled} />
      </div>
    )
  }

  // Ein Schalter braucht keine eigene Zeile ueber sich: Name links, Schalter
  // rechts, eine Zeile hoch wie jedes andere Feld auch.
  if (schema.type === 'boolean') {
    return (
      <label title={schema.description}
        className="flex h-[var(--control-h-md)] cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-control)] border border-white/[0.08] bg-white/[0.04] px-2.5">
        <Feldname text={titel} />
        <input disabled={disabled} type="checkbox" checked={!!current} onChange={(e) => onChange(e.target.checked)} className="accent-lu-accent" />
      </label>
    )
  }

  const zahl = schema.type === 'integer' || schema.type === 'number'
  const lesen = (v: string) => (zahl ? (v === '' ? undefined : Number(v)) : v === '' ? undefined : v)

  return (
    <label title={schema.description} className="block space-y-1.5">
      <Feldname text={titel} />
      {schema.enum ? (
        <select disabled={disabled} className={cn(fieldClass, 'cursor-pointer')} value={String(current)} onChange={(e) => onChange(lesen(e.target.value))}>
          {schema.default === undefined && <option value="">Automatic</option>}
          {schema.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
        </select>
      ) : (
        <div className="flex items-center gap-1.5">
          <input disabled={disabled} className={cn(fieldClass, zahl && 'lu-hud-num')}
            type={zahl ? 'number' : 'text'} min={schema.minimum} max={schema.maximum} step={schema.type === 'integer' ? 1 : 'any'}
            value={String(current)} onChange={(e) => onChange(lesen(e.target.value))} />
          {name === 'seed' && (
            <button type="button" disabled={disabled} title="Randomize" aria-label="Randomize seed"
              onClick={() => onChange(Math.floor(Math.random() * 2_147_483_647))}
              className="inline-flex aspect-square h-[var(--control-h-md)] shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-white/[0.06] text-gray-400 transition-colors hover:bg-white/10 hover:text-white">
              <Dices size={14} />
            </button>
          )}
        </div>
      )}
    </label>
  )
}
