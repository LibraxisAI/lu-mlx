/**
 * @vitest-environment jsdom
 *
 * F1, N9-Nachtest Windows-Box (19.09.2026, box-gruen/n2/BERICHT.md
 * Teil A): "+ New Chat" legt sofort eine aktive, aber leere Unterhaltung an
 * (`createConversation` in chatStore.ts setzt `activeConversationId`
 * synchron). Bei AUFGEKLAPPTER Seitenleiste (dem Normalzustand) griff die
 * alte Bedingung `showRecentsAboveComposer = !sidebarOpen && activeConvIsEmpty`
 * nie, und `<MessageList>` mit null Nachrichten zeichnet selbst keinen
 * Platzhalter. Ergebnis: ein vollstaendig leerer Hauptbereich, reproduzierbar
 * auch nach vollem Neuladen (auf der Windows-Box zweimal beobachtet), bis ein
 * Wechsel auf einen anderen Reiter `activeConversationId` ueber
 * `Sidebar.tsx` (Klick auf "Chat") auf `null` zurueckstellt und dabei den
 * ECHTEN Leerzustand zeigt.
 *
 * Dieser Test haelt fest: eine aktive, leere Unterhaltung zeigt den
 * Leerzustand-Block ("Ask LU anything") IMMER, unabhaengig vom
 * Seitenleisten-Zustand, nicht nur wenn `activeConversationId === null`
 * ist. Die Liste der letzten Chats bleibt darin weiterhin nur bei
 * zugeklappter Seitenleiste (D-S06, siehe home-recent-chats.test.ts).
 *
 * Run: npx vitest run src/components/chat/__tests__/leer-aktive-unterhaltung.test.ts
 *
 * Auflage A3 (review-leer2-offload.md): dieselbe leere Flaeche traf auch
 * einen dispatchten Remote-Chat vor der ersten Mobil-Nachricht, weil die
 * Bedingung `conv.mode !== 'lu'` jeden anderen Modus ausschloss. `mode:
 * 'remote'` zaehlt jetzt mit (Fix in ChatView.tsx, activeConvIsEmpty).
 *
 * BLOCKER (review-teil15.md): der A3-Umbau schrieb die Bedingung als
 * `conv.mode !== 'lu' && conv.mode !== 'remote'` und liess dabei die alte
 * Vorbelegung "kein mode-Feld heisst lu" fallen. Fuer eine Unterhaltung ohne
 * `mode` (Chats von vor 5382d831, oder importiert ueber
 * lib/parsers/chatbot-export.ts) lautete das Ergebnis wieder `false`, also
 * derselbe leere Hauptbereich wie das urspruengliche F1-Symptom. Fix: die
 * Vorbelegung sitzt jetzt in genau einer Stelle, `lib/conversation-mode.ts`,
 * und ChatView.tsx wie RecentChats.tsx lesen beide von dort.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { ChatView } from '../ChatView'
import { useUIStore } from '../../../stores/uiStore'
import { useChatStore } from '../../../stores/chatStore'
import { useCompareStore } from '../../../stores/compareStore'
import { useModelStore } from '../../../stores/modelStore'
import type { Conversation } from '../../../types/chat'

vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0)
const conv = (id: string, title: string, updatedAt: number): Conversation => ({
  id, title, messages: [], model: 'test-model', systemPrompt: '', mode: 'lu',
  createdAt: updatedAt, updatedAt,
})

beforeEach(() => {
  useCompareStore.setState({ isComparing: false })
  useModelStore.setState({ activeModel: 'test-model', models: [{ name: 'test-model' } as never] })
  useChatStore.setState({
    conversations: [conv('fresh', 'New Chat', NOW)],
    activeConversationId: 'fresh',
  })
})

afterEach(() => {
  cleanup()
})

describe('F1: eine aktive, leere Unterhaltung zeigt nie einen komplett leeren Hauptbereich', () => {
  it('aufgeklappte Seitenleiste: der Leerzustand-Block steht trotzdem da (vorher: GAR NICHTS)', () => {
    useUIStore.setState({ sidebarOpen: true })
    render(createElement(ChatView))
    expect(screen.getByTestId('chat-landing')).toBeTruthy()
    expect(screen.getByText('Ask LU anything')).toBeTruthy()
  })

  it('aufgeklappte Seitenleiste: keine zweite Chat-Liste im Hauptbereich (Doppelung mit der Seitenleiste)', () => {
    useUIStore.setState({ sidebarOpen: true })
    render(createElement(ChatView))
    expect(screen.queryByTestId('home-recent-chats')).toBeNull()
  })

  it('zugeklappte Seitenleiste: derselbe Block, plus die Liste der letzten Chats darin', () => {
    useChatStore.setState({
      conversations: [conv('a', 'Yesterdays thread', NOW - 3600_000), conv('fresh', 'New Chat', NOW)],
      activeConversationId: 'fresh',
    })
    useUIStore.setState({ sidebarOpen: false })
    render(createElement(ChatView))
    expect(screen.getByTestId('chat-landing')).toBeTruthy()
    expect(screen.getByText('Ask LU anything')).toBeTruthy()
    expect(screen.getByTestId('home-recent-chats').textContent).toContain('Yesterdays thread')
  })

  it('NEGATIVKONTROLLE: sobald die erste Nachricht da ist, weicht der Block dem Transkript', () => {
    useUIStore.setState({ sidebarOpen: true })
    useChatStore.setState({
      conversations: [{
        ...conv('fresh', 'New Chat', NOW),
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: NOW }],
      }],
      activeConversationId: 'fresh',
    })
    render(createElement(ChatView))
    expect(screen.queryByTestId('chat-landing')).toBeNull()
  })

  it('NEGATIVKONTROLLE: keine aktive Unterhaltung bleibt der bekannte Leerzustand (unveraendert)', () => {
    useUIStore.setState({ sidebarOpen: true })
    useChatStore.setState({ conversations: [], activeConversationId: null })
    render(createElement(ChatView))
    expect(screen.getByTestId('chat-landing')).toBeTruthy()
  })

  it('BLOCKER-FIX (review-teil15.md): eine leere Unterhaltung OHNE mode-Feld zeigt den Leerzustand, nicht eine leere Flaeche', () => {
    // Pre-Migration-Chats (mode eingefuehrt 5382d831, 05.04.2026) und Importe
    // ueber chatbot-export.ts tragen kein `mode`-Feld. `conv.mode` ist hier
    // absichtlich `undefined`, nicht `'lu'`.
    useUIStore.setState({ sidebarOpen: true })
    const { mode: _mode, ...withoutMode } = conv('legacy', 'Legacy Chat', NOW)
    useChatStore.setState({
      conversations: [withoutMode as Conversation],
      activeConversationId: 'legacy',
    })
    render(createElement(ChatView))
    expect(screen.getByTestId('chat-landing')).toBeTruthy()
    expect(screen.getByText('Ask LU anything')).toBeTruthy()
  })

  it('A3: ein dispatchter, noch leerer Remote-Chat zeigt denselben Leerzustand-Block, nicht eine leere Flaeche', () => {
    useUIStore.setState({ sidebarOpen: true })
    useChatStore.setState({
      conversations: [{ ...conv('remote1', 'Remote', NOW), mode: 'remote' }],
      activeConversationId: 'remote1',
    })
    render(createElement(ChatView))
    expect(screen.getByTestId('chat-landing')).toBeTruthy()
    expect(screen.getByText('Ask LU anything')).toBeTruthy()
  })

  it('A3-WAECHTER (keine Negativkontrolle fuer diesen Fix, siehe review-teil15.md Auflage 3): ein Remote-Chat mit der ersten Nachricht weicht dem Transkript, wie bei lu; waere auch ohne den A3-Fix gruen, weil ein Remote-Chat vor A3 nie einen Landing-Block zeigte', () => {
    useUIStore.setState({ sidebarOpen: true })
    useChatStore.setState({
      conversations: [{
        ...conv('remote2', 'Remote', NOW),
        mode: 'remote',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: NOW }],
      }],
      activeConversationId: 'remote2',
    })
    render(createElement(ChatView))
    expect(screen.queryByTestId('chat-landing')).toBeNull()
  })
})
