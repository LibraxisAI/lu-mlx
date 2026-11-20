/**
 * @vitest-environment jsdom
 *
 * „NICHTS im prompt fenster!"
 *
 * 21.09.2026, mehrfach und veraergert, am echten Windows-Bau. Der
 * Befund lag als Bild vor (e2e/box-gruen/t15/shots/B3-dropdown-hint.png):
 * direkt ueber der Chat-Eingabe, IM Kasten des Composers, stand eine Leiste
 * mit x und dem Satz
 *
 *   "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" is gone from the model
 *   list, so the chat switched to "Qwen3.5-9B-Q4_K_M".
 *
 * Die Regel, die daraus folgt: ueber, in und unmittelbar an der Eingabezeile
 * steht kein Hinweis, kein Banner, kein Toast und kein Fehlertext.
 * Bedienelemente und die Vorschau des eigenen Anhangs duerfen bleiben, denn
 * das sind keine Saetze, die man liest, sondern Dinge, die man benutzt.
 *
 * Zwei Haelften, und beide werden gebraucht:
 *
 *   1. Die Quellpruefung unten haelt fest, dass die drei Composer-Dateien
 *      die inventarisierten Hinweis-Bauteile nicht mehr einhaengen. Sie
 *      faellt auch dann, wenn jemand ein NEUES Hinweisbauteil dort einhaengt,
 *      denn sie prueft `composerAbove` als Ganzes.
 *   2. Die Renderpruefungen belegen, dass kein Hinweis dabei verlorengegangen
 *      ist: jeder Ausloeser zeigt seinen Text weiterhin, nur woanders.
 *
 * Run: npx vitest run src/components/chat/__tests__/nichts-im-promptfenster.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatNotices } from '../ChatNotices'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'

const CHAT = resolve(__dirname, '..')
const lies = (name: string) => readFileSync(resolve(CHAT, name), 'utf8')

/** Quelltext ohne Kommentare: diese Dateien ERKLAEREN den Umzug und nennen
 *  die Bauteile dabei beim Namen. Ein Test, der „ist das weg" fragt, faende
 *  sonst die Begruendung statt des Codes. */
const nurCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Die Hinweis- und Fehlerbauteile aus der Inventur, die dort nicht mehr
 *  eingehaengt werden duerfen. */
const HINWEIS_BAUTEILE = ['LuEngineSwitchBar', 'RetrievalErrorBar'] as const

describe('der Composer haengt keine Hinweis-Bauteile mehr ein', () => {
  it('ChatInput ZEICHNET keinen einzigen Hinweis mehr', () => {
    const src = nurCode(lies('ChatInput.tsx'))
    // Kein Hinweisbauteil und keine handgebaute Hinweiszeile, auch keine neue.
    expect(src).not.toMatch(/<Hinweis[\s/>]/)
    expect(src).not.toContain('HINWEIS_ZEILE')
    expect(src).not.toContain('HINWEIS_TEXT')
    // Und keine Meldung als Text im JSX: `role="status"` und `role="alert"`
    // sind die beiden Rollen, die eine gelesene Zeile traegt. Der Composer
    // hat keine mehr.
    expect(src).not.toMatch(/role=['"](?:status|alert)['"]/)
    // Die drei Saetze, die dort standen, stehen nicht mehr IM JSX. Die
    // Wortlaute selbst duerfen bleiben: `addFiles` SCHICKT einen davon
    // weiterhin los, nur zeichnet ihn eine Etage hoeher.
    const jsx = src.slice(src.indexOf('return ('))
    expect(jsx).not.toContain('Waiting for the local model')
    expect(jsx).not.toContain('The model only gets a summary')
    expect(jsx).not.toContain("This model can't read images")
  })

  it('kein Hinweisbauteil haengt mehr IM Kasten', () => {
    // `ChatInput.tsx` ist der Kasten selbst, dort gilt die Regel fuer die
    // ganze Datei. In den beiden Ansichten gilt sie fuer das, was in den
    // Kasten hineingereicht wird, also fuer `composerAbove`: dass ChatView
    // den Retrieval-Fehler OBEN IM VERLAUF zeichnet, ist der Umzug und nicht
    // sein Gegenteil.
    const input = nurCode(lies('ChatInput.tsx'))
    for (const bauteil of HINWEIS_BAUTEILE) {
      expect(input, `ChatInput zeichnet noch <${bauteil} />`).not.toContain(bauteil)
    }
    for (const datei of ['ChatView.tsx', 'CodexView.tsx'] as const) {
      const durchgereicht = nurCode(lies(datei)).match(/composerAbove=\{([^}]*)\}/)?.[1] ?? ''
      for (const bauteil of HINWEIS_BAUTEILE) {
        expect(durchgereicht, `${datei} reicht <${bauteil} /> in den Kasten`).not.toContain(bauteil)
      }
    }
  })

  it('und der Retrieval-Fehler steht in ChatView VOR dem Composer, nicht darin', () => {
    // Die Gegenprobe zum Umzug: er ist nicht geloescht, er steht jetzt oben
    // im Verlauf. Faellt diese Zeile, ist ein Fehler stillschweigend
    // verschwunden statt umgezogen.
    const src = nurCode(lies('ChatView.tsx'))
    const bar = src.indexOf('<RetrievalErrorBar />')
    const composer = src.indexOf('<ChatInput')
    expect(bar, 'RetrievalErrorBar ist ganz verschwunden').toBeGreaterThan(0)
    expect(bar).toBeLessThan(composer)
  })

  it('CodexView hat sein `composerAbove` ganz verloren', () => {
    expect(nurCode(lies('CodexView.tsx'))).not.toContain('composerAbove')
  })

  it('in ChatViews `composerAbove` steht genau die eine Geldzeile', () => {
    // Das ist die einzige Ausnahme, und sie steht unter Vorbehalt des
    // Eigners: `GroupCostHint` sagt, was der naechste Enter kostet. Geld wird
    // nicht stillschweigend stumm geschaltet. Kommt hier etwas dazu, faellt
    // dieser Fall und die Frage wird neu gestellt.
    const m = nurCode(lies('ChatView.tsx')).match(/composerAbove=\{([^}]*)\}/)
    expect(m, 'ChatView reicht kein composerAbove mehr durch').toBeTruthy()
    expect(m![1].trim()).toBe('<GroupCostHint />')
  })

  it('die Bedienelemente sind NICHT mitausgezogen', () => {
    // Die Gegenprobe zur Regel: waere hier alles verschwunden, haette der
    // Composer seine Arbeit verloren statt seiner Hinweise.
    const src = lies('ChatInput.tsx')
    for (const teil of ['ApprovalDialog', 'SamplingControls', 'composerModel', 'composerActions', 'Send message', 'Stop generation']) {
      expect(src, `${teil} fehlt im Composer`).toContain(teil)
    }
  })
})

describe('ChatNotices: der neue Platz, oben im Verlauf', () => {
  beforeEach(() => useChatNoticeStore.getState().clear())
  afterEach(() => { cleanup(); useChatNoticeStore.getState().clear() })

  it('zeigt gar nichts, solange es nichts zu sagen gibt', () => {
    render(<ChatNotices />)
    expect(screen.queryByTestId('chat-notices')).toBeNull()
  })

  it('zeigt die Zeile ueber ein angehaengtes Dokument, und das x nimmt sie weg', () => {
    useChatNoticeStore.getState().show(
      'document-belongs-in-docs',
      'The model only gets a summary of this document. To ask about its text, add it in the Documents panel.',
    )
    render(<ChatNotices />)
    expect(screen.getByTestId('chat-notices').textContent).toContain('The model only gets a summary of this document')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('chat-notices')).toBeNull()
    expect(useChatNoticeStore.getState().notices).toEqual([])
  })

  it('bietet den Weg in die Dokumentenablage an, wenn es einen gibt', () => {
    let geoeffnet = 0
    useChatNoticeStore.getState().show('document-belongs-in-docs', 'The model only gets a summary of this document.')
    render(<ChatNotices onAttachDocs={() => { geoeffnet += 1 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Documents' }))
    expect(geoeffnet).toBe(1)
    // Und die Zeile hat sich dabei selbst erledigt: der Nutzer ist schon dort.
    expect(useChatNoticeStore.getState().notices).toEqual([])
  })

  it('GEGENPROBE: ohne den Weg dorthin bleibt der Satz wahr und der Knopf weg', () => {
    useChatNoticeStore.getState().show('document-belongs-in-docs', 'The model only gets a summary of this document.')
    render(<ChatNotices />)
    expect(screen.queryByRole('button', { name: 'Open Documents' })).toBeNull()
    expect(screen.getByTestId('chat-notices').textContent).toContain('The model only gets a summary of this document')
  })

  it('zeigt die Zeile des blinden Modells', () => {
    useChatNoticeStore.getState().show(
      'model-cannot-see-images',
      "This model can't read images. Switch to a vision model (Gemma 4, LLaVA, Qwen-VL) to use the attachment.",
    )
    render(<ChatNotices />)
    expect(screen.getByTestId('chat-notices').textContent).toContain("This model can't read images")
  })

  it('derselbe Name zweimal stapelt nicht, er ersetzt', () => {
    const s = useChatNoticeStore.getState()
    s.show('model-cannot-see-images', 'erst')
    s.show('model-cannot-see-images', 'dann')
    expect(useChatNoticeStore.getState().notices).toHaveLength(1)
    expect(useChatNoticeStore.getState().notices[0].text).toBe('dann')
  })
})
