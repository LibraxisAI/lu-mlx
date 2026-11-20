// Der Presenter-Waehler.
//
// 19.09.2026, Entscheid des Inhabers: "man muss ja irgendwie den Charakter vorher
// auswaehlen, bevor man Geld ausgibt fuer eine Generation". Eine Namensliste
// mit 500 Eintraegen leistet das nicht. Also Kacheln mit Gesicht, Suche ueber
// den Namen, und die Person steht als Ueberschrift ueber ihren Posen: dieselbe
// Person kommt in bis zu zwanzig Szenen vor.
//
// Das Feld klappt nach unten auf, statt als Schwebefenster ueber der Seite zu
// liegen. Beide Orte, die es zeigen, sind Rollkaesten: das Optionsfenster im
// Composer und die Spalte im Preset-Fenster. Ein Schwebefenster darin wird am
// Rand des Kastens abgeschnitten, und zwar genau oben, wo die Suche steht.

import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '../ui/cn'
import { avatarPerson, avatarPreview } from '../../../lib/render/heygen-avatars'

export function AvatarPicker({ names, value, onChange, disabled }: {
  names: string[]; value: string; onChange: (v: string) => void; disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const treffer = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? names.filter((n) => n.toLowerCase().includes(q)) : names
  }, [names, query])

  const bild = avatarPreview(value)

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label="Presenter"
        aria-expanded={open}
        className="t-control flex w-full items-center gap-2 rounded-md border border-white/10 bg-white/[.025] px-2 py-1.5 text-left text-gray-200 transition-colors hover:border-white/25 disabled:opacity-50"
      >
        {bild
          ? <img src={bild} alt="" width={40} height={23} className="h-[23px] w-10 shrink-0 rounded-sm object-cover" />
          : <span className="h-[23px] w-10 shrink-0 rounded-sm bg-white/[.06]" />}
        <span className="min-w-0 flex-1 truncate">{value || 'Choose a presenter'}</span>
        <ChevronDown size={13} className={cn('shrink-0 text-gray-500 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="mt-1 rounded-md border border-white/10 bg-black/20">
          <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-2 py-1.5">
            <Search size={13} className="text-gray-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search presenters…"
              aria-label="Search presenters"
              className="t-control w-full bg-transparent text-gray-200 placeholder-gray-600 outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto scrollbar-thin p-1">
            {treffer.length === 0 && <div className="t-control px-1.5 py-2 text-gray-600">No matches</div>}
            {treffer.map((name, i) => {
              const person = avatarPerson(name)
              const kopf = person !== (treffer[i - 1] ? avatarPerson(treffer[i - 1]) : null)
              return (
                <div key={name} className={cn(kopf && 'mt-1.5 first:mt-0')}>
                  {kopf && <div className="t-micro px-0.5 pb-1 text-gray-500">{person}</div>}
                  <AvatarKachel name={name} selected={name === value} onPick={() => { onChange(name); setOpen(false); setQuery('') }} />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function AvatarKachel({ name, selected, onPick }: { name: string; selected: boolean; onPick: () => void }) {
  const bild = avatarPreview(name)
  // Die Szene ohne den Personennamen: unter der Ueberschrift "Annie" steht
  // "Bar Standing Side 2", nicht noch einmal Annie.
  const szene = name.slice(avatarPerson(name).length).trim() || name
  return (
    <button
      onClick={onPick}
      title={name}
      aria-label={name}
      aria-pressed={selected}
      className={cn(
        't-control flex w-full items-center gap-2 rounded-[6px] px-1 py-1 text-left transition-colors',
        selected ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/[0.06]',
      )}
    >
      {bild
        ? <img src={bild} alt="" width={56} height={32} loading="lazy" className={cn('h-8 w-14 shrink-0 rounded-sm object-cover', selected && 'ring-1 ring-lu-accent')} />
        : <span className="t-micro flex h-8 w-14 shrink-0 items-center justify-center rounded-sm bg-white/[.06] text-gray-600">no photo</span>}
      <span className="min-w-0 flex-1 truncate">{szene}</span>
    </button>
  )
}
