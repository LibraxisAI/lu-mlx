/**
 * @vitest-environment jsdom
 *
 * Senden und Stop gehoeren der Unterhaltung, nicht der App.
 *
 * Befund T1 (Box, 11.09.2026), Punkt 4 und Nebenfund 4: "Der Sendeknopf
 * verschwindet global, solange irgendwo eine Antwort laeuft. In jedem anderen
 * Chat steht dort der Stopp-Knopf, der die fremde Erzeugung abbricht." Der
 * Komposer las eine einzige app-weite Fahne (`useChat().isGenerating`),
 * obwohl der generationStore die Wahrheit seit 22f76b04 je Unterhaltung
 * fuehrt und die Schreibanzeige sie auch schon las.
 *
 * Warum hier zum Zeitpunkt dieses Befunds nur die halbe Strecke stand: ein
 * vollstaendiges "jede Unterhaltung darf gleichzeitig senden" hing an den
 * geteilten Stream-Puffern in useChat.ts (contentRef, thinkingRef, abortRef)
 * und useAgentChat.ts, rund 110 Zugriffe, und daran, dass `runInLane` aus
 * lib/run-slot.ts damals keinen Aufrufer in der Produktion hatte: ohne
 * Warteschlange liefen zwei lokale Laeufe gegen einen llama-server mit einem
 * einzigen Slot. useChat.ts hat seine Haelfte seit B2 Commit 1/2
 * (ChatRun-Objekt statt Refs, generationStore statt abortRef): siehe
 * useChat-zwei-laeufe-vermischen-nicht.test.ts. useAgentChat.ts hat seine
 * Haelfte seit B2 NEUER FUND (AgentRunState-Objekt statt Refs,
 * activeAgentRuns statt abortRef/abortConvRef/runningRef, Wiedereintritts-
 * Riegel je Unterhaltung statt app-weit): siehe
 * useAgentChat-zwei-agentenlaeufe-vermischen-nicht.test.ts. Runde 4
 * (review-lanes.md Blocker 1+6) hat `runInLane` seither in alle drei
 * Sendewege verdrahtet: siehe useChat-lokale-spur-reiht-zweite-sendung-ein,
 * useAgentChat-lokale-spur-reiht-zweiten-agentenlauf-ein und
 * useCodex-lokale-spur-reiht-zweiten-lauf-ein. Die Oberflaeche unten haelt
 * die App-weite Fahne fuer Regenerate/Edit deshalb bewusst, nicht mehr wegen
 * geteilter Puffer. Was hier steht, ist das, was schon vorher richtig wurde:
 * der laufende Chat behaelt Stop und bricht nur sich selbst ab, der andere
 * behaelt seinen Sendeknopf und bekommt einen englischen Satz statt eines
 * stummen Tauschs.
 *
 * Run: npx vitest run src/components/chat/__tests__/senden-und-stop-je-unterhaltung.test.tsx
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { composerBusy } from '../../../lib/composer-busy'
import { useCodex } from '../../../hooks/useCodex'
import { useGenerationStore } from '../../../stores/generationStore'
import { useChatStore } from '../../../stores/chatStore'

const src = (rel: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), rel), 'utf8')

const sendButton = () => screen.queryByRole('button', { name: 'Send message' }) as HTMLButtonElement | null
const stopButton = () => screen.queryByRole('button', { name: 'Stop generation' })

beforeEach(() => cleanup())

/**
 * Runde 4 (review-lanes.md Blocker 1+6): the cross-conversation lock this
 * file used to test (`busyElsewhere`, "Another chat is still answering...")
 * is gone from `ChatInput` entirely. It is no longer needed: a second local
 * send now queues visibly instead of racing the first one for the built-in
 * engine's one slot (see composer-zeigt-warten-auf-lokale-spur.test.tsx for
 * that line), and a second cloud send just runs alongside the first. What is
 * left to prove here is the negative: a conversation that is NOT the one
 * answering keeps an ordinary, USABLE Send button, full stop, regardless of
 * what `composerBusy` reports about some other conversation.
 */
describe('the composer of a chat that is NOT the one answering', () => {
  /** What ChatView hands down while conversation `b` is the one generating:
   *  `thisChat` is what still reaches ChatInput's `isGenerating`. */
  const asSeenFromA = composerBusy(true, { b: true }, 'a')

  it('keeps its Send button instead of losing it to a foreign run, and shows no waiting line', () => {
    render(
      <ChatInput
        onSend={() => {}}
        onStop={() => { throw new Error('a foreign run must not be stoppable from here') }}
        isGenerating={asSeenFromA.thisChat}
      />,
    )
    expect(sendButton()).toBeTruthy()
    expect(stopButton()).toBeNull()
    expect(screen.queryByTestId('composer-busy-elsewhere')).toBeNull()
    expect(screen.queryByTestId('composer-waiting-local-lane')).toBeNull()
  })

  it('does fire a send while another chat is answering, no lock left to stop it', () => {
    let sent = 0
    render(
      <ChatInput onSend={() => { sent += 1 }} onStop={() => {}} isGenerating={asSeenFromA.thisChat} modelReady={() => true} />,
    )
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'hello' } })
    expect(sendButton()!.disabled).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toBe(1)
  })
})

describe('the composer of the chat that IS answering', () => {
  const asSeenFromB = composerBusy(true, { b: true }, 'b')

  it('shows Stop, and no waiting line', () => {
    let stopped = 0
    render(
      <ChatInput onSend={() => {}} onStop={() => { stopped += 1 }} isGenerating={asSeenFromB.thisChat} />,
    )
    expect(sendButton()).toBeNull()
    expect(screen.queryByTestId('composer-busy-elsewhere')).toBeNull()
    fireEvent.click(stopButton()!)
    expect(stopped).toBe(1)
  })

  it('COUNTER-CHECK: an idle chat shows Send and says nothing', () => {
    const idle = composerBusy(false, {}, 'b')
    render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={idle.thisChat} />)
    expect(sendButton()).toBeTruthy()
    expect(sendButton()!.disabled).toBe(true) // empty box, not a busy engine
    expect(screen.queryByTestId('composer-busy-elsewhere')).toBeNull()
  })
})

/**
 * Die zweite Haelfte des Befunds sass (Stand vor B2) in zwei Hooks, deren
 * Abbruchgriffe der Hook-INSTANZ gehoerten und nicht der Unterhaltung. Beide
 * sind seither gefixt (useChat B2 Commit 2, useAgentChat B2 NEUER FUND), der
 * dritte (useCodex) folgt unten.
 */
describe('Stop bricht nur die eigene Erzeugung ab', () => {
  it('useChat hat kein Instanz-Ref mehr, das ein zweiter Lauf ueberschreiben koennte', () => {
    const chat = src('../../../hooks/useChat.ts')
    expect(chat).not.toMatch(/abortConvRef/)
    expect(chat).not.toMatch(/const abortRef = useRef/)
    // Der EINE Griff, der wirklich abbricht, bleibt: je Konversation, im
    // generationStore, nicht in einem Hook-Ref.
    expect(chat).toMatch(/useGenerationStore\.getState\(\)\.abortConversation\(convId\)/)
  })

  it('useAgentChat hat kein Instanz-Ref mehr, das ein zweiter Lauf ueberschreiben koennte', () => {
    const agent = src('../../../hooks/useAgentChat.ts')
    expect(agent).not.toMatch(/abortConvRef/)
    expect(agent).not.toMatch(/const abortRef = useRef/)
    expect(agent).not.toMatch(/const runningRef = useRef/)
    // Der Griff, der wirklich abbricht, ist jetzt je Unterhaltung: eine Map,
    // keine Hook-Instanz.
    expect(agent).toMatch(/const activeAgentRuns = new Map<string, AgentRunState>\(\)/)
    const stopAgent = agent.slice(agent.indexOf('const stopAgent = useCallback'))
    expect(stopAgent).toMatch(/activeAgentRuns\.get\(stoppedConvId\)/)
    expect(stopAgent).toMatch(/runToStop\.abort\.abort\(\)/)
    expect(stopAgent).toMatch(/activeAgentRuns\.delete\(stoppedConvId!\)/)
    // setIsAgentRunning(false) darf NICHT mehr unbedingt stehen: das war die
    // Zeile, die den fremden Lauf aus der Oberflaeche loeschte. Es steht nur
    // noch bedingt, unter demselben `if (runToStop)`, das den eigenen Lauf
    // gefunden haben muss.
    expect(agent).not.toMatch(/drainApprovals\(stoppedConvId\)\s*\n\s*setIsAgentRunning\(false\)/)
  })

  /**
   * R2-19: der dritte Hook mit demselben Griff. `stopCodex` brach ihn
   * bedingungslos ab, und V2a hat nachgewiesen, dass `CodexView` beim
   * Unterhaltungswechsel NICHT neu montiert wird (`ChatView.tsx` gibt ihm kein
   * `key`). Ein Lauf in A, Wechsel nach B, Stop gedrueckt: A war tot.
   */
  /**
   * Runde 3 (review-lanes.md): dieser Test war bis hierher ein reiner
   * Quelltextpin auf `abortConvRef`, dem Griff, den Nachbesserung 5 dieser
   * Runde aus useCodex.ts entfernt hat (der Ref war seit B2 Commit 3 tote
   * Duplikation neben dem echten, identitaetsgeprueften Abbrecher im
   * generationStore, siehe useCodex.ts). Der Pin wurde rot, weil der Griff,
   * den er beschrieb, nicht mehr existiert, nicht weil Stop kaputt ist. Statt
   * den Pin auf den neuen Namen (`activeCodexRuns`) umzuschreiben, beweist
   * dieser Test jetzt das eigentliche Verhalten: `stopCodex` bricht den
   * echten Abbrecher NUR der genannten Unterhaltung ab.
   */
  it('useCodex bricht den Controller der Instanz nur fuer die eigene Unterhaltung ab', () => {
    const convA = 'stop-test-conv-a'
    const convB = 'stop-test-conv-b'
    useChatStore.setState({ conversations: [], activeConversationId: convA })
    useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })

    let abortedA = 0
    let abortedB = 0
    useGenerationStore.getState().registerAborter(convA, () => { abortedA++ })
    useGenerationStore.getState().registerAborter(convB, () => { abortedB++ })

    const { result } = renderHook(() => useCodex())
    act(() => { result.current.stopCodex(convA) })

    expect(abortedA).toBe(1)
    expect(abortedB).toBe(0)

    // COUNTER-CHECK auf den Test selbst: stoppt man die andere Unterhaltung,
    // trifft es auch wirklich nur sie.
    act(() => { result.current.stopCodex(convB) })
    expect(abortedB).toBe(1)
    expect(abortedA).toBe(1)
  })

  it('und CodexView wird beim Unterhaltungswechsel wirklich nicht neu montiert', () => {
    // Die Voraussetzung des Befunds, damit sie nicht still verschwindet: gaebe
    // es hier ein `key`, waere der Griff bei jedem Wechsel frisch und die
    // Klammer oben ueberfluessig. Sie ist es nicht.
    const view = src('../ChatView.tsx')
    expect(view).toMatch(/<CodexView\b/)
    expect(view).not.toMatch(/<CodexView[^>]*\skey=/)
  })

  it('der Komposer liest nicht mehr die app-weite Fahne', () => {
    const view = src('../ChatView.tsx')
    const composer = view.slice(view.indexOf('<ChatInput'), view.indexOf('composerActions='))
    // Runde 4 Schritt 2 (review-lanes.md Blocker 1+6): `isGenerating` traegt
    // jetzt auch den Warteschlangen-Fall (`queuedForLocalLane`), damit der
    // Stop-Knopf schon waehrend des Wartens auf die lokale Spur steht, nicht
    // erst wenn der Strom beginnt. Schritt 4: `busyElsewhere` ist ganz weg,
    // kein Aufrufer sperrt mehr wegen einer ANDEREN Unterhaltung. Die Aussage
    // dieses Tests bleibt dieselbe: kein app-weites `isGenerating`, alles
    // hier ist je-Unterhaltung.
    expect(composer).toContain('isGenerating={busy.thisChat || queuedForLocalLane}')
    expect(composer).not.toContain('busyElsewhere')
    expect(composer).toContain('waitingForLocalLane={queuedForLocalLane}')
    expect(composer).not.toContain('isGenerating={isGenerating}')
    // Die MessageList behaelt die app-weite Fahne mit Absicht: Regenerate und
    // Edit STARTEN einen Lauf, und solange die Stream-Puffer geteilt sind,
    // darf ein zweiter Lauf nirgends anfangen. Genau deshalb sagt der
    // Komposer den Grund, statt den Knopf wegzunehmen.
    expect(view).toContain('isGenerating={isGenerating}')
    expect(view).toContain('isThisChatGenerating={activeGenerating}')
  })
})
