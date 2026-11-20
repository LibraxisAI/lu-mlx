/**
 * Die Nachricht und ihre Aktionen — D-S07 und D-S08.
 *
 *   D-S07  „Aktionsleiste ist dauerhaft sichtbar, nicht hover-gated: drei
 *          12px-Icons unter jeder Nachricht, immer."
 *   D-S08  „Zwei Avatar-Systeme: Assistent rahmenlos, User als gerahmte Box
 *          mit 11px-Icon."
 *
 * Zu D-S07 gehoert eine Abwaegung, und dieser Test haelt BEIDE Seiten davon
 * fest, nicht nur die bequeme:
 *
 *   Verstecken ist nur deshalb vertretbar, weil es seit `f2650788` einen
 *   zweiten Weg zu denselben Aktionen gibt — das Kontextmenue auf der
 *   Nachricht, ueber DIESELBEN Handler. Faellt dieser zweite Weg weg, ist das
 *   Verstecken ein Funktionsverlust und muss zurueckgenommen werden. Deshalb
 *   prueft dieser Test das Kontextmenue mit; wer es entfernt, faellt hier
 *   durch und liest den Grund.
 *
 * Und die drei Dinge, die am Verstecken schiefgehen koennen, sind einzeln
 * festgenagelt: der Layoutplatz (sonst springt das Transkript unter dem
 * Mauszeiger), der Tastaturfokus (sonst ist der Knopf fokussierbar, aber
 * unsichtbar) und die Rueckmeldung nach dem Klick (sonst sieht niemand
 * „Copied").
 *
 * Am laufenden Fenster nachgemessen (2026-09-01, localhost:5273): ohne Zeiger
 * `opacity: 0`, unter dem Zeiger `opacity: 1`, mit Tastaturfokus auf dem
 * Kopieren-Knopf `opacity: 1`.
 *
 * Run: npx vitest run src/components/chat/__tests__/eine-nachricht-eine-leiste.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHAT = resolve(__dirname, '..')
const read = (f: string) => readFileSync(resolve(CHAT, f), 'utf-8')

const BUBBLE = read('MessageBubble.tsx')
const CODEX = read('CodexView.tsx')
const SLOT = read('avatar-slot.ts')

function ohneKommentare(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

const CODE = ohneKommentare(BUBBLE)
const CODEX_CODE = ohneKommentare(CODEX)

describe('D-S07: die Leiste erscheint, wenn man sie meint', () => {
  it('sie ist im Ruhezustand unsichtbar', () => {
    expect(CODE).toMatch(/const actionBarVisibility =/)
    expect(CODE).toContain('opacity-0 group-hover:opacity-100')
  })

  it('und die Klasse haengt wirklich an der Leiste, nicht irgendwo daneben', () => {
    const bar = CODE.slice(CODE.indexOf('{actionsAvailable && ('), CODE.indexOf('aria-label="Edit message"'))
    expect(bar).toContain('actionBarVisibility')
    expect(bar).toMatch(/aria-label="Edit message"|justify-end pr-0\.5/)
  })

  it('der Container traegt `group` — ohne das greift `group-hover` an nichts', () => {
    expect(CODE).toMatch(/className=\{'flex gap-2 px-3 py-1 group '/)
  })

  it('Tastaturfokus zeigt sie auch — sonst faehrt der Fokus ins Unsichtbare', () => {
    expect(CODE).toContain('group-focus-within:opacity-100')
  })

  it('sie behaelt ihren Layoutplatz — kein `hidden`, kein `absolute`', () => {
    // Der Gegenentwurf (D-S15, Sidebar) ist dort richtig und hier falsch: die
    // Zeile liegt UNTER der Nachricht. Entstuende sie erst beim Hovern, braeche
    // das Transkript unter dem Mauszeiger um.
    const vis = CODE.slice(CODE.indexOf('const actionBarVisibility ='), CODE.indexOf('return (', CODE.indexOf('const actionBarVisibility =')))
    expect(vis).not.toMatch(/\bhidden\b/)
    expect(vis).not.toMatch(/\babsolute\b/)
    expect(vis).toContain('transition-opacity')
  })

  it('eine laufende Rueckmeldung haelt sie offen', () => {
    // „Copied" und „Click again to delete" sind Antworten auf einen Klick.
    // Zoege die Maus weiter, waere die Antwort auf die eigene Geste unsichtbar.
    expect(CODE).toMatch(/copied \|\| confirmDelete\s*\?\s*'opacity-100'/)
  })
})

describe('D-S07: das Verstecken ist nur mit dem zweiten Weg vertretbar', () => {
  it('das Kontextmenue auf der Nachricht existiert', () => {
    expect(CODE).toMatch(/<ContextMenu/)
    expect(CODE).toMatch(/onContextMenu=\{\(e\) => \{/)
  })

  it('und bietet DIESELBEN Aktionen ueber DIESELBEN Handler an', () => {
    // `buildMessageMenu` reicht die Funktionen unveraendert als `run` durch.
    // Zwei getrennte Handler-Saetze waeren die Doppelung, die dieses Projekt
    // schon mehrfach bezahlt hat.
    expect(CODE).toMatch(/items=\{buildMessageMenu\(actions, \{ copied, confirmDelete \}\)\}/)
    expect(CODE).toMatch(/const actions: MessageMenuHandlers = \{/)
    expect(CODE).toMatch(/onClick=\{actions\.copy\}/)
    expect(CODE).toMatch(/onClick=\{actions\.remove\}/)
  })

  it('beide haengen an derselben Bedingung — sonst laufen sie auseinander', () => {
    expect(CODE).toMatch(/const actionsAvailable = !isEditing && !isStreaming/)
    expect(CODE).toMatch(/if \(!actionsAvailable\) return/)
    expect(CODE).toMatch(/\{actionsAvailable && \(/)
  })
})

describe('the avatar column: a chip for the user, the bare mark for the model', () => {
  it('the recipe stands once, in its own file', () => {
    expect(SLOT).toMatch(/const PLACE = 'w-6 h-6 flex items-center justify-center shrink-0'/)
    expect(SLOT).toMatch(/export const AVATAR_SLOT = `\$\{PLACE\} /)
    expect(SLOT).toMatch(/export const MODEL_MARK = 'w-5 h-5 object-contain/)
  })

  it('the model has no chip: no surface and no frame behind its mark', () => {
    // Its place is the bare place, nothing added.
    expect(SLOT).toMatch(/export const MODEL_MARK_SLOT = PLACE\n/)
    expect(/const PLACE = '([^']*)'/.exec(SLOT)![1]).not.toMatch(/bg-|border|rounded/)
    // The chip stays what it was, for the user.
    expect(SLOT).toContain('rounded-md overflow-hidden bg-gray-100 dark:bg-white/8 border border-gray-200 dark:border-white/10`')
  })

  it('the mark is as large as the mark that shows while the model works', () => {
    // w-5 is 20 px, and so is the grid of the working mark.
    expect(read('../status/glyph-geometry.ts')).toMatch(/export const GRID = 20\b/)
    expect(SLOT).toMatch(/MODEL_MARK = 'w-5 h-5 /)
  })

  it('chat and code view both draw from it, and the chip belongs to the user alone', () => {
    for (const [name, code, user] of [['MessageBubble', CODE, 'isUser'], ['CodexView', CODEX_CODE, "msg.role === 'user'"]] as const) {
      expect(code, name).toContain(`{${user} ? (\n`)
      expect(code.match(/className=\{AVATAR_SLOT\}/g), name).toHaveLength(1)
      expect(code.match(/className=\{MODEL_MARK_SLOT\}/g), name).toHaveLength(1)
      expect(code, name).toContain('<img src={MONOGRAM} alt="" className={`${MODEL_MARK} ${MONOGRAM_INVERT}`} />')
      const chip = code.slice(code.indexOf('className={AVATAR_SLOT}'), code.indexOf('className={MODEL_MARK_SLOT}'))
      expect(chip, name).not.toContain('MONOGRAM')
    }
    expect(BUBBLE).toMatch(/import \{ AVATAR_SLOT, MODEL_MARK, MODEL_MARK_SLOT \} from '\.\/avatar-slot'/)
    expect(CODEX).toMatch(/import \{ AVATAR_SLOT, MODEL_MARK, MODEL_MARK_SLOT \} from '\.\/avatar-slot'/)
  })

  it('neither file spells out a slot of its own next to it', () => {
    for (const [name, code] of [['MessageBubble', CODE], ['CodexView', CODEX_CODE]] as const) {
      expect(code, name).not.toMatch(/w-6 h-6 rounded-md overflow-hidden/)
      expect(code, name).not.toMatch(/w-5 h-5 rounded overflow-hidden/)
      expect(code, name).not.toMatch(/w-\[70%\] h-\[70%\]/)
    }
  })
})
