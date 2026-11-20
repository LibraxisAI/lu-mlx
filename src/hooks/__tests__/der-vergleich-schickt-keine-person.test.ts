// @vitest-environment jsdom
/**
 * R2-8, zweite Haelfte. Entscheid vom 12.09.2026: der A/B-Vergleich
 * schickt keine Person mehr mit, nur die Frage.
 *
 * Gemessen wird der ANFRAGEKOERPER, nicht der Quelltext. Die Zeile, die die
 * Person anhaengte, liess sich an drei Stellen wieder einbauen, ohne dass ein
 * Quelltextwaechter es gemerkt haette; was zaehlt, ist das Nachrichtenarray,
 * das bei beiden Anbietern ankommt.
 *
 * Run: npx vitest run src/hooks/__tests__/der-vergleich-schickt-keine-person.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ChatMessage } from '../../api/providers/types'

/** Was jede Seite des Vergleichs wirklich abgeschickt hat. */
const abgeschickt: ChatMessage[][] = []

vi.mock('../../api/providers', () => ({
  getProviderIdFromModel: () => 'lu-cloud',
  getProviderForModel: (model: string) => ({
    modelId: model,
    provider: {
      // eslint-disable-next-line require-yield
      chatStream: async function* (_id: string, messages: ChatMessage[]) {
        abgeschickt.push(messages)
      },
    },
  }),
}))
vi.mock(import('../../lib/context-compaction'), async (original) => ({
  ...(await original()),
  // Kein Netz im Test: das Fenster steht fest, damit der Sendedeckel rechnet
  // wie an einem Wolkenmodell.
  getModelMaxTokens: async () => 32768,
}))

const { useABCompare } = await import('../useABCompare')
const { useCompareStore } = await import('../../stores/compareStore')
const { useSettingsStore } = await import('../../stores/settingsStore')
const { CHAT_BASE_SYSTEM_PROMPT, HOUSE_RULES } = await import('../../lib/system-prompt')

const PIRAT = 'You are a pirate. Answer in pirate speech only.'

beforeEach(() => {
  abgeschickt.length = 0
  useCompareStore.setState({ modelA: 'modell-a', modelB: 'modell-b', messagesA: [], messagesB: [] })
  // Die Lage, in der die alte Zeile zuschlug: eine global gewaehlte Person und
  // der globale Personenschalter auf an. Ohne sie waere der Waechter blind.
  useSettingsStore.setState((state) => ({
    activePersonaId: 'pirat',
    personas: [...state.personas, { id: 'pirat', name: 'Pirat', systemPrompt: PIRAT, icon: '', color: '' } as never],
    settings: { ...state.settings, personasEnabled: true },
  }))
})

describe('der A/B-Vergleich', () => {
  it('schickt die Person nicht mit, auch wenn eine global gewaehlt ist', async () => {
    // Die Person steht wirklich scharf, sonst prueft der Test nichts.
    expect(useSettingsStore.getState().getActivePersona()?.systemPrompt).toBe(PIRAT)

    const haken = renderHook(() => useABCompare())
    await haken.result.current.sendCompare('Was ist ein Zinssatz?')

    expect(abgeschickt, 'nicht beide Seiten haben gesendet').toHaveLength(2)
    for (const [index, nachrichten] of abgeschickt.entries()) {
      const seite = index === 0 ? 'A' : 'B'
      const text = JSON.stringify(nachrichten)
      expect(text, `Seite ${seite} traegt die Person im Koerper`).not.toContain('pirate')
      expect(nachrichten.filter((m) => m.role === 'system'), `Seite ${seite}: nicht genau ein Systemtext`).toHaveLength(1)
      // Negativkontrolle in dieselbe Richtung: der Hausteil faellt NICHT mit
      // der Person weg. Ohne ihn antwortet das Modell aus der Haltung seines
      // Anbieters, und dann vergleicht der Lauf nicht LU.
      expect(nachrichten[0].content, `Seite ${seite} hat den Grundtext verloren`).toBe(CHAT_BASE_SYSTEM_PROMPT)
      expect(nachrichten[0].content).toContain(HOUSE_RULES)
      expect(nachrichten.at(-1), `Seite ${seite} hat die Frage verloren`)
        .toEqual({ role: 'user', content: 'Was ist ein Zinssatz?' })
    }
  })
})
