/**
 * Kundenfall 30.09.2026 (zweite Mail): "when it stopped i will
 * continue the task then its start from again reapting same and same always".
 * Am Ende eines Laufs bleiben nur die letzten 60 Nachrichten der Werkzeugkette
 * gespeichert. Was davor lag, stand nirgends mehr, auch nicht im sichtbaren
 * Verlauf, also fing der naechste Zug von vorn an.
 *
 * Run: npx vitest run src/hooks/codex/__tests__/weiter-kennt-den-anfang.test.ts
 */
import { describe, it, expect } from 'vitest'
import { capHiddenToolHistory } from '../hidden-history'
import type { ChatMessage } from '../../../api/providers/types'

function lauf(schritte: number): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < schritte; i++) {
    out.push({
      role: 'assistant', content: `step ${i}`,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'file_read', arguments: { path: `src/file-${i}.ts` } } }],
    } as unknown as ChatMessage)
    out.push({ role: 'tool', content: 'x', tool_call_id: `c${i}` } as unknown as ChatMessage)
  }
  return out
}

describe('die gekappte Werkzeugkette', () => {
  it('traegt die weggeschnittenen Schritte als Protokoll', () => {
    const kette = capHiddenToolHistory(lauf(100))
    expect(kette.length).toBeLessThanOrEqual(60)
    const erste = String(kette[0].content)
    expect(erste).toContain('[Run ledger]')
    // 70 Schritte fielen weg: die juengsten 40 namentlich, die aelteren gezaehlt.
    expect(erste).toContain('(30 older steps)')
    expect(erste).toContain('file_read: src/file-30.ts')
    expect(erste).toContain('file_read: src/file-69.ts')
    // Nichts doppelt: was behalten ist, steht nicht im Protokoll.
    expect(erste).not.toContain('src/file-70.ts')
    // Der Aufruf selbst ist unveraendert, die Paarung bleibt.
    expect(kette[0].role).toBe('assistant')
    expect((kette[0] as unknown as { tool_calls: unknown[] }).tool_calls).toHaveLength(1)
    expect(kette[1].role).toBe('tool')
  })

  it('laesst eine kurze Kette ohne Protokoll', () => {
    const kette = capHiddenToolHistory(lauf(10))
    expect(kette).toHaveLength(20)
    expect(String(kette[0].content)).toBe('step 0')
  })
})
