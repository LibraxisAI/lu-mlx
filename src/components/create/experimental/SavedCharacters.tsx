// The saved characters as a row of chips: one click loads a character's
// photos. Shown at the reference strip and on the Character Studio board.
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  deleteSavedCharacter, listSavedCharacters, subscribeSavedCharacters, type SavedCharacter,
} from '../../../lib/saved-characters'
import { cn } from '../ui/cn'

export interface SavedCharacterView extends SavedCharacter {
  /** Preview of the first photo. */
  thumb: string
}

/** The saved characters, kept current after every save and delete. */
export function useSavedCharacters(): SavedCharacterView[] {
  const [list, setList] = useState<SavedCharacterView[]>([])
  useEffect(() => {
    let alive = true
    let urls: string[] = []
    const load = () => {
      void listSavedCharacters().then((rows) => {
        if (!alive) return
        const old = urls
        const next = rows.filter((c) => c.photos.length > 0).map((c) => ({ ...c, thumb: URL.createObjectURL(c.photos[0]) }))
        urls = next.map((n) => n.thumb)
        setList(next)
        for (const u of old) URL.revokeObjectURL(u)
      }).catch(() => { /* no list is not an error worth a banner */ })
    }
    load()
    const off = subscribeSavedCharacters(load)
    return () => {
      alive = false
      off()
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [])
  return list
}

export function SavedCharacterChips({ label, title, onPick, disabled }: {
  label: string
  /** Tooltip of a chip, given the character. */
  title: (c: SavedCharacter) => string
  onPick: (c: SavedCharacter) => void
  disabled?: boolean
}) {
  const list = useSavedCharacters()
  const [confirm, setConfirm] = useState<string | null>(null)
  if (list.length === 0) return null
  return (
    <div className="flex flex-col items-center gap-1.5 max-w-full" data-testid="saved-characters">
      <span className="t-label text-gray-600">{label}</span>
      <div className="flex flex-wrap justify-center gap-1.5">
        {list.map((c) => (
          <div key={c.id} className="group relative flex items-center rounded-full bg-white/[0.04] border border-white/[0.06] hover:border-white/15 transition-colors">
            <button
              onClick={() => onPick(c)}
              disabled={disabled}
              title={title(c)}
              className={cn('flex items-center gap-1.5 pl-1 pr-2 py-1 t-control text-gray-300 hover:text-white', disabled && 'opacity-50 cursor-not-allowed')}
            >
              <img src={c.thumb} alt="" className="w-6 h-6 rounded-full object-cover" />
              <span className="truncate max-w-[9rem]">{c.name}</span>
              <span className="t-micro text-gray-500">{c.photos.length}</span>
            </button>
            {confirm === c.id ? (
              <button
                onClick={() => { setConfirm(null); void deleteSavedCharacter(c.id) }}
                onBlur={() => setConfirm(null)}
                className="pr-2 t-control text-red-300 hover:text-red-200"
              >
                Delete?
              </button>
            ) : (
              <button
                onClick={() => setConfirm(c.id)}
                title={`Delete ${c.name}`}
                aria-label={`Delete ${c.name}`}
                className="pr-2 text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
