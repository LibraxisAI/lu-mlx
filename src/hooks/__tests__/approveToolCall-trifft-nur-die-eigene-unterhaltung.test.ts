/**
 * @vitest-environment jsdom
 *
 * B2 Plan-Punkt 2: eine Freigabe in Unterhaltung B darf NIE einen
 * Werkzeugaufruf in A starten. Sicherheitsfehler, keine Kosmetik: eine
 * Freigabe ist eine bewusste Entscheidung des Nutzers ueber EINE konkrete
 * Aktion in EINER konkreten Unterhaltung, und ein Klick in B, der A
 * beantwortet, waere eine Aktion ohne die Zustimmung, die sie zu haben
 * behauptet.
 *
 * `lib/approval-queue.ts` fuehrt die Warteschlange bereits als
 * `Map<convId, ApprovalEntry[]>` (G29b), mit eigenem Modultest fuer die
 * Trennung. Dieser Test prueft die zweite Haelfte: die HOOK-VERDRAHTUNG in
 * useAgentChat.ts (`approveToolCall`/`rejectToolCall`), die den aktiven
 * Konversations-Schluessel liest und dequeueApproval() damit aufruft, echt
 * ueber zwei montierte Konversationen hinweg, nicht nur am Modul selbst.
 *
 * Vorbild: das Web-Repo (Commit 1b1b1ce6) fuehrt seine `approvalQueueRef` ebenfalls als Map je
 * Unterhaltung; dieselbe Form, hier am Desktop-Hook nachgemessen statt nur
 * am Modul.
 *
 * Run: npx vitest run src/hooks/__tests__/approveToolCall-trifft-nur-die-eigene-unterhaltung.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentChat } from '../useAgentChat'
import { useChatStore } from '../../stores/chatStore'
import { enqueueApproval, resetApprovals, type ApprovalEntry } from '../../lib/approval-queue'
import type { AgentToolCall } from '../../types/agent-mode'

const call = (id: string): AgentToolCall =>
  ({ id, toolName: 'file_write', args: {}, status: 'pending_approval' }) as AgentToolCall

const entry = (id: string): ApprovalEntry & { answered: boolean[] } => {
  const answered: boolean[] = []
  return { toolCall: call(id), resolve: (ok) => answered.push(ok), answered }
}

function seed(): string {
  return useChatStore.getState().createConversation('lu-cloud::zai-org/GLM-5.3', '')
}

beforeEach(() => {
  resetApprovals()
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

describe('approveToolCall/rejectToolCall treffen nur die aktive Unterhaltung', () => {
  it('Freigeben in B beantwortet NICHT den wartenden Werkzeugaufruf von A', () => {
    const convA = seed()
    const convB = seed()

    const waitingInA = entry('tc-A')
    const waitingInB = entry('tc-B')
    enqueueApproval(convA, waitingInA)
    enqueueApproval(convB, waitingInB)

    const { result } = renderHook(() => useAgentChat())

    // A ist NICHT die aktive Unterhaltung wenn B freigegeben wird - genau die
    // Reihenfolge, in der ein Klick "in B" versehentlich "in A" treffen
    // koennte, wenn die Verdrahtung den falschen Schluessel laese.
    act(() => { useChatStore.getState().setActiveConversation(convB) })
    act(() => { result.current.approveToolCall() })

    // B's eigener Aufruf ist beantwortet, JA.
    expect(waitingInB.answered).toEqual([true])
    // A's Aufruf ist UNBERUEHRT: weder ja noch nein, er wartet noch echt.
    expect(waitingInA.answered).toEqual([])
  })

  it('COUNTER-CHECK: Ablehnen in A trifft wirklich A, nicht B', () => {
    const convA = seed()
    const convB = seed()

    const waitingInA = entry('tc-A')
    const waitingInB = entry('tc-B')
    enqueueApproval(convA, waitingInA)
    enqueueApproval(convB, waitingInB)

    const { result } = renderHook(() => useAgentChat())

    act(() => { useChatStore.getState().setActiveConversation(convA) })
    act(() => { result.current.rejectToolCall() })

    expect(waitingInA.answered).toEqual([false])
    expect(waitingInB.answered).toEqual([])
  })

  it('eine Unterhaltung ohne wartenden Aufruf beantwortet bei Freigabe niemanden', () => {
    const convA = seed()
    const convB = seed()
    const waitingInA = entry('tc-A')
    enqueueApproval(convA, waitingInA)
    // B hat NICHTS in der Warteschlange.

    const { result } = renderHook(() => useAgentChat())
    act(() => { useChatStore.getState().setActiveConversation(convB) })
    act(() => { result.current.approveToolCall() })

    expect(waitingInA.answered).toEqual([])
  })
})
