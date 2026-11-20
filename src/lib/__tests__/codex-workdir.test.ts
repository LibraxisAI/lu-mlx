/**
 * The two verdicts A8 turned out to need, pulled out of the hook and the two
 * views so they can be tested at all (review S6, S3).
 *
 * "Is a run in flight" was written out by hand on each surface, once per
 * surface, differently. That is how the first cut of the fix ended up locking
 * the folder picker whenever an unrelated Chat tab was streaming.
 *
 * Die Rangfolge des Arbeitsordners stand bis 3.0.0 ebenfalls hier, als zweite
 * Rechnung ohne Aufrufer. Sechs Faelle massen sie, und keiner davon fasste die
 * ausgelieferte Rechnung an. Beides ist weg; gemessen wird die lebende Stelle
 * in `src/hooks/codex/__tests__/ein-lauf.test.ts` (R2-42).
 *
 * Run: npx vitest run src/lib/__tests__/codex-workdir.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  CODEX_WORKDIR_LOCK_TITLE,
  codexBusyReason,
  codexFallbackLabel,
} from '../codex-workdir'

describe('what the empty state is allowed to promise', () => {
  it('names the workspace that actually wins over an empty picker', () => {
    expect(codexFallbackLabel('/home/alex/default-repo')).toBe('/home/alex/default-repo')
  })

  it('and only says the sandbox when nothing else is pinned', () => {
    expect(codexFallbackLabel(null)).toBe('~/agent-workspace')
    expect(codexFallbackLabel('')).toBe('~/agent-workspace')
  })
})

describe('when the working directory is held', () => {
  const free = { sendsInFlight: 0, threads: {}, generating: {}, loop: null }

  it('is free when nothing at all is going on', () => {
    expect(codexBusyReason(free)).toBeNull()
  })

  it('is held from the first synchronous moment of a send', () => {
    expect(codexBusyReason({ ...free, sendsInFlight: 1 })).toBe('run')
  })

  it('is held by a thread that is really streaming', () => {
    expect(codexBusyReason({
      ...free,
      threads: { a: { status: 'running' } },
      generating: { a: true },
    })).toBe('run')
  })

  it('and by one waiting for an approval or writing its staged changes', () => {
    // Beides ist laufende Arbeit. Der Vergleich von Hand fragte `=== running`
    // und liess genau diese beiden Zustaende als "nichts los" durch.
    for (const status of ['awaiting_approval', 'applying', 'cancelling'] as const) {
      expect(codexBusyReason({
        ...free,
        threads: { a: { status } },
        generating: { a: true },
      }), status).toBe('run')
    }
  })

  it('but a thread left standing on running by a dead run holds nothing', () => {
    // Der Fall, der den Ordner fuer den Rest der Sitzung sperrte: Stop raeumt
    // die Erzeugungsfahne sofort, der Status kommt erst im `finally` des Laufs
    // zurueck, und ein Shell-Befehl, der das Signal nicht beachtet, dehnt das
    // Fenster beliebig weit. Der Status allein ist kein Beweis, dass noch
    // etwas laeuft.
    expect(codexBusyReason({
      ...free,
      threads: { a: { status: 'running' } },
      generating: {},
    })).toBeNull()
    // Und eine Fahne, die auf false steht, ist dasselbe wie keine.
    expect(codexBusyReason({
      ...free,
      threads: { a: { status: 'running' } },
      generating: { a: false },
    })).toBeNull()
  })

  it('a run in ANOTHER chat still holds it, a chat tab streaming does not', () => {
    // Beide Haelften auf einmal: die Fahne zaehlt nur zusammen mit einem
    // Faden des Coding-Agenten, sonst sperrte jeder streamende Chat-Reiter
    // diese Spalte mit (Pruefung S3).
    expect(codexBusyReason({
      ...free,
      threads: { a: { status: 'running' } },
      generating: { a: true },
    })).toBe('run')
    expect(codexBusyReason({ ...free, threads: {}, generating: { chat: true } })).toBeNull()
  })

  it('is held between two loop passes, where the thread says idle', () => {
    // The dangerous gap: status idle, next pass on a setTimeout. Moving the
    // folder here used to send that pass somewhere else with nobody watching.
    expect(codexBusyReason({
      ...free,
      threads: { a: { status: 'idle' } },
      loop: { conversationId: 'a', pass: 2, cap: 0, task: 't', intervalMs: 30000, nextAt: 0 },
    })).toBe('loop')
  })

  it('an idle thread on its own holds nothing', () => {
    expect(codexBusyReason({ ...free, threads: { a: { status: 'idle' }, b: { status: 'error' } } })).toBeNull()
  })

  it('a finished send releases it, and a double release cannot go negative', () => {
    expect(codexBusyReason({ ...free, sendsInFlight: 0 })).toBeNull()
    expect(codexBusyReason({ ...free, sendsInFlight: -1 })).toBeNull()
  })

  it('says a different sentence for a loop than for a run', () => {
    expect(CODEX_WORKDIR_LOCK_TITLE.run).not.toBe(CODEX_WORKDIR_LOCK_TITLE.loop)
    expect(CODEX_WORKDIR_LOCK_TITLE.loop).toContain('loop')
  })

  it('and every sentence names a way out, not just a wait', () => {
    // Warten ist keine Auskunft, solange der Nutzer nicht weiss, worauf. Beide
    // Saetze nennen deshalb den Knopf, der die Sperre wirklich loest: Stop
    // raeumt die Erzeugungsfahne, und der Ordner ist im selben Augenblick frei.
    for (const satz of Object.values(CODEX_WORKDIR_LOCK_TITLE)) {
      expect(satz, satz).toContain('Stop')
    }
  })
})
