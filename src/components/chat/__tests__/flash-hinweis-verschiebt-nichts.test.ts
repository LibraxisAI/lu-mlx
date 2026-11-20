/**
 * 19.09.2026: das Flash-Band stand dauerhaft ueber dem Eingabefeld und
 * schob den Agent-Schalter, die Kontextanzeige und Memories nach oben. Der
 * Hinweis ist jetzt ein einzeiliges Etikett in der Sitzungsleiste, direkt
 * neben `AgentModeToggle`, mit einem Popup ausserhalb des Layoutflusses, genau
 * wie `SamplingControls` (der Sampling-Regler).
 *
 * Nachtrag, selber Tag: der Inhaber wollte danach auch die zweite Zeile ueber dem
 * Eingabefeld weg, `ModelMarks` ("No Filter" und, vor der ersten
 * Nachbesserung, auch "No credits"). Die Komponente ist geloescht (toter Code,
 * nicht nur entkoppelt), `ChatInput.tsx` kennt sie nicht mehr. Was sie zeigte,
 * lebt an zwei Stellen weiter: "No credits"/"Using credits" im Etikett neben
 * dem Agent-Schalter (`FlashChatNotice`), und BEIDE Marken unveraendert in der
 * Modellauswahl (`ModelRowMarks` in `ModelSelector.tsx`), dort informiert
 * sich der Nutzer, nicht ueber dem Feld, in das er gerade tippt.
 *
 * Dieser Test liest Quelltext, nicht das gerenderte DOM, aus demselben Grund
 * wie `zwei-baender-sind-eine-flaeche.test.ts`: die Behauptung ist eine
 * Platzierung im Baum, nicht ein Pixelwert, und der Quelltext sagt sie direkt.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const COMPONENTS = resolve(__dirname, '..', '..')
const read = (rel: string) => readFileSync(resolve(COMPONENTS, rel), 'utf-8')

const CHAT_INPUT = read('chat/ChatInput.tsx')
const CHAT_VIEW = read('chat/ChatView.tsx')
const CODEX_VIEW = read('chat/CodexView.tsx')
const NOTICE = read('chat/FlashChatNotice.tsx')
const SAMPLING = read('chat/SamplingControls.tsx')
const MODEL_SELECTOR = read('models/ModelSelector.tsx')

describe('kein Element des Flash-Hinweises oberhalb des Eingabefelds', () => {
  it('ChatInput kennt FlashChatNotice nicht mehr', () => {
    expect(CHAT_INPUT).not.toContain('FlashChatNotice')
  })
})

// Nachtrag: ModelMarks (die "No Filter"/"No credits"-Zeile ueber dem
// Eingabefeld) ist nicht nur entkoppelt, sondern geloescht. Dieser Block wird
// rot, falls sie oder ein Nachfolger wieder auftaucht: das war der Fund, den
// die 3.0.0-Waechter (marken-ein-bauteil.test.tsx im Web) bisher in die
// GEGENRICHTUNG absicherten ("dieselben Marken auch ueber der Eingabezeile"),
// bevor der Inhaber das umgedreht hat.
describe('keine Marke jeder Art oberhalb des Eingabefelds', () => {
  it('die Komponente ist wirklich weg, nicht nur entkoppelt', () => {
    expect(existsSync(resolve(COMPONENTS, 'chat/ModelMarks.tsx'))).toBe(false)
  })

  it('ChatInput kennt ModelMarks nicht mehr', () => {
    expect(CHAT_INPUT).not.toContain('ModelMarks')
  })

  it('die Modellauswahl selbst traegt beide Marken weiterhin unveraendert', () => {
    expect(MODEL_SELECTOR).toContain('<ModelRowMarks')
  })
})

describe('der Hinweis steht in der Sitzungsleiste, neben dem Agent-Schalter', () => {
  const stripStart = CHAT_VIEW.indexOf('data-testid="chat-session-strip"')

  it('die Leiste wurde gefunden', () => {
    expect(stripStart).toBeGreaterThan(-1)
  })

  it('AgentModeToggle und FlashChatNotice stehen beide darin, FlashChatNotice direkt danach', () => {
    const strip = CHAT_VIEW.slice(stripStart, stripStart + 1500)
    const agent = strip.indexOf('<AgentModeToggle')
    const notice = strip.indexOf('<FlashChatNotice')
    const spacer = strip.indexOf('flex-1')
    expect(agent).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(-1)
    expect(spacer).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(agent)
    expect(notice).toBeLessThan(spacer)
  })

  it('und in der Code-Symbolleiste, derselbe Baustein wie im Chat', () => {
    expect(CODEX_VIEW).toContain('<FlashChatNotice')
  })
})

describe('das Popup liegt ausserhalb des Layoutflusses, wie der Sampling-Regler', () => {
  it('FlashChatNotice setzt position: absolute fuers Panel, dieselbe Bauart', () => {
    expect(NOTICE).toMatch(/position:\s*'absolute'/)
    expect(SAMPLING).toMatch(/position:\s*'absolute'/)
  })

  // Runde 3 (Abnahme 19.09.2026, Blocker A1): die Sitzungsleiste steht unter
  // dem Transkript, direkt ueber dem Composer, nicht oben. Ein Panel, das
  // nach UNTEN oeffnet (`top: '100%'`), liefe dort aus dem Fenster und wuerde
  // vom `overflow-hidden`-Vorfahren in ChatView.tsx abgeschnitten. Nur
  // `position: absolute` zu pruefen (wie zuvor) faengt das nicht, deshalb
  // steht hier zusaetzlich die Richtung selbst: `bottom: '100%'`, wie
  // `SamplingControls`, und explizit NICHT `top: '100%'`.
  it('das Panel oeffnet nach OBEN, wie SamplingControls, nicht nach unten', () => {
    expect(NOTICE).toMatch(/bottom:\s*'100%'/)
    expect(NOTICE).not.toMatch(/top:\s*'100%'/)
    expect(SAMPLING).toMatch(/bottom:\s*'100%'/)
  })

  it('das Panel klemmt seine Hoehe auf den freien Platz ueber dem Trigger', () => {
    expect(NOTICE).toContain('clampNoticeMaxHeight')
    expect(NOTICE).toMatch(/maxHeight:\s*panelBox\.maxHeight/)
    expect(NOTICE).toMatch(/overflowY:\s*'auto'/)
  })

  it('der Ausloeser ist eine einzeilige Zeile, kein Block mit eigener Hoehe', () => {
    // Kein `mb-*` und kein `flex-col` am Wurzelelement: eine Marke, die selbst
    // Rand oder Zeilenumbruch mitbringt, macht die Leiste hoeher.
    const wurzel = NOTICE.slice(NOTICE.indexOf('return ('), NOTICE.indexOf('{open &&'))
    expect(wurzel).not.toMatch(/\bmb-\d/)
    expect(wurzel).not.toMatch(/flex-col/)
    expect(wurzel).toMatch(/whitespace-nowrap/)
  })

  it('schliesst per Escape, X und Aussenklick, wie SamplingControls', () => {
    expect(NOTICE).toMatch(/useDismissOnEscape\(open, close\)/)
    expect(NOTICE).toContain('pointerdown')
    expect(NOTICE).toContain('FLASH_NOTICE_CLOSE_LABEL')
  })
})
