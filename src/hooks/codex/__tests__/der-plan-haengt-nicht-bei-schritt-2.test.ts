/**
 * Fehler D, Symptom 2. Discord, 08.09.2026, Windows 11,
 * LU 2.6.8, Ollama, Code Reiter: "during code generation the plan hangs at
 * step 2, sometimes restarts at 0".
 *
 * ── WAS HIER ECHT LAEUFT ───────────────────────────────────────────────────
 * Der wirkliche Ollama Transport (`streamOllamaChatWithTools`) gegen einen
 * NDJSON Strom, wie Ollama ihn schickt; der wirkliche `todoStore` ueber
 * `writeTodos` und der wirkliche `AgentLoopGuard`. Nur `localFetchStream` ist ersetzt, also genau das Kabel.
 * Das ist die "Schrittmaschine" des Plans: einen Schritt weiterzaehlen kann in
 * LU ausschliesslich das Modell ueber `todo_write`, der Speicher ersetzt die
 * Liste jedes Mal ganz.
 *
 * ── WAS DER LAUF ZEIGT ─────────────────────────────────────────────────────
 * Ein Plan aus zwei Schritten kommt ueber Schritt 2 hinaus, ohne dass eine der
 * Bremsen dazwischenfaehrt: die Schleifenwache haelt nicht an, und die
 * Luecke schliesst sich am Ende. Der
 * Haenger sitzt also NICHT in dieser Kette.
 *
 * ── WO ER SITZEN KANN, UND WAS DAFUER FEHLTE ───────────────────────────────
 * Ollama meldet einen abgeschnittenen Zug im letzten Stueck des Stroms als
 * `done_reason: "length"`. `wire.ts` liest das Feld seit jeher aus, der
 * regulaere Chat gibt es als `finishReason` weiter (ollama-provider.ts:252)
 * und `useChat.ts` sagt dem Nutzer dann, dass das Token Budget alle war. Der
 * Transport des CODING AGENTEN warf es weg.
 *
 * Damit war ein Zug, den das Modell nie zu Ende schreiben konnte, fuer die
 * Schleife nicht von einem Modell zu unterscheiden, das fertig ist: keine
 * Werkzeugaufrufe, also `break-no-toolcalls`, Lauf zu Ende, kein Wort. Der
 * Plan steht danach genau da, wo er stand, auf seinem offenen Schritt. Und
 * der naechste Zug bekommt ueber den Anker die
 * Aufforderung, die VOLLSTAENDIGE Liste noch einmal zu schicken; ein Modell,
 * dem der Verlauf weggeschnitten wurde, schickt sie dann von vorn. Das ist
 * beides, was der Melder beschreibt.
 *
 * Lauf: npx vitest run src/hooks/codex/__tests__/der-plan-haengt-nicht-bei-schritt-2.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../../../api/backend', () => ({
  localFetchStream: vi.fn(),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
}))

import { streamOllamaChatWithTools } from '../../../lib/ollama-stream-tools'
import { localFetchStream } from '../../../api/backend'
import { useTodoStore, writeTodos, type TodoItem } from '../../../stores/todoStore'
import { openPlanGap } from '../../../lib/plan-reconcile'
import { AgentLoopGuard } from '../../../lib/agent-loop-guard'
import { codexCutoffNote } from '../turn-cutoff'
import type { ToolCall, ToolDefinition } from '../../../api/providers/types'

const mockStream = localFetchStream as ReturnType<typeof vi.fn>

const CONV = 'bug-d-plan'

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'write the plan',
      parameters: { type: 'object', properties: { todos: { type: 'array', description: 'the plan' } }, required: ['todos'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] },
    },
  },
]

/** Ein Ollama NDJSON Strom aus fertigen Zeilen. */
function ndjson(...lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', { status: 200 })
}

/** Die Zeile, mit der Ollama einen Werkzeugaufruf schickt. */
function callLine(name: string, args: unknown): string {
  return JSON.stringify({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false })
}

/** Die Schlusszeile eines Zuges. */
function doneLine(reason: string, content = ''): string {
  return JSON.stringify({ message: { content }, done: true, done_reason: reason, eval_count: 42, prompt_eval_count: 900 })
}

/** Ein Zug ueber den echten Transport. */
function turn(...lines: string[]) {
  mockStream.mockResolvedValueOnce(ndjson(...lines))
  return streamOllamaChatWithTools(
    'qwen2.5-coder:14b',
    [{ role: 'user', content: 'refactor the parser' }],
    TOOLS,
    { temperature: 0.1 },
    () => {},
    () => {},
  )
}

const PLAN_START: TodoItem[] = [
  { content: 'read the parser', status: 'in_progress' },
  { content: 'rewrite the token loop', status: 'pending' },
]
const PLAN_MID: TodoItem[] = [
  { content: 'read the parser', status: 'completed' },
  { content: 'rewrite the token loop', status: 'in_progress' },
]
const PLAN_DONE: TodoItem[] = [
  { content: 'read the parser', status: 'completed' },
  { content: 'rewrite the token loop', status: 'completed' },
]

/** Die Werkzeugnamen eines Zuges, wie die Schleife sie den Waechtern gibt. */
const namesOf = (calls: ToolCall[]) => calls.map((c) => c.function.name)
const guardBatch = (calls: ToolCall[]) =>
  calls.map((c) => ({ name: c.function.name, args: JSON.stringify(c.function.arguments) }))

beforeEach(() => {
  mockStream.mockReset()
  useTodoStore.getState().clearTodos(CONV)
})

describe('ein Plan aus zwei Schritten kommt ueber Schritt 2 hinaus', () => {
  it('zaehlt 0 zu 2, dann 1 zu 2, dann zu', async () => {
    const guard = new AgentLoopGuard()

    // Zug 1: das Modell schreibt den Plan.
    const t1 = await turn(callLine('todo_write', { todos: PLAN_START }), doneLine('stop'))
    expect(namesOf(t1.toolCalls)).toEqual(['todo_write'])
    writeTodos(CONV, (t1.toolCalls[0].function.arguments as { todos: unknown }).todos)
    expect(openPlanGap(useTodoStore.getState().getTodos(CONV))).toEqual({
      done: 0, total: 2, next: 'read the parser',
    })
    expect(guard.recordBatch(guardBatch(t1.toolCalls)).action).toBe('ok')

    // Zug 2: echte Arbeit, kein todo_write. Eine stille Runde ist noch keine.
    const t2 = await turn(callLine('file_read', { path: 'src/parser.ts' }), doneLine('stop'))
    expect(namesOf(t2.toolCalls)).toEqual(['file_read'])
    expect(guard.recordBatch(guardBatch(t2.toolCalls)).action).toBe('ok')

    // Zug 3: Schritt 1 fertig, Schritt 2 ist dran. DAS ist der Uebergang, an
    // dem der Melder haengenbleibt.
    const t3 = await turn(callLine('todo_write', { todos: PLAN_MID }), doneLine('stop'))
    writeTodos(CONV, (t3.toolCalls[0].function.arguments as { todos: unknown }).todos)
    expect(openPlanGap(useTodoStore.getState().getTodos(CONV))).toEqual({
      done: 1, total: 2, next: 'rewrite the token loop',
    })
    expect(guard.recordBatch(guardBatch(t3.toolCalls)).action).toBe('ok')

    // Zug 4: Schritt 2 wird getan, und zwar an einer anderen Datei, sonst
    // zaehlt die Schleifenwache zu Recht eine Wiederholung.
    const t4 = await turn(callLine('file_read', { path: 'src/lexer.ts' }), doneLine('stop'))
    expect(guard.recordBatch(guardBatch(t4.toolCalls)).action).toBe('ok')

    // Zug 5: der Plan schliesst. Jetzt darf der Lauf enden.
    const t5 = await turn(callLine('todo_write', { todos: PLAN_DONE }), doneLine('stop'))
    writeTodos(CONV, (t5.toolCalls[0].function.arguments as { todos: unknown }).todos)
    expect(openPlanGap(useTodoStore.getState().getTodos(CONV))).toBeNull()
  })

  it('ein als JSON Zeichenkette geschickter Plan kommt genauso an', async () => {
    // Kleine lokale Modelle schicken `arguments` als Zeichenkette. Das war
    // schon einmal der Grund fuer "file_write needs argument", und fuer den
    // Plan hiesse es: die Liste kommt nie an, der Balken steht still.
    const t = await turn(
      callLine('todo_write', JSON.stringify({ todos: PLAN_MID })),
      doneLine('stop'),
    )
    writeTodos(CONV, (t.toolCalls[0].function.arguments as { todos: unknown }).todos)
    expect(openPlanGap(useTodoStore.getState().getTodos(CONV))?.done).toBe(1)
  })

  it('dieselbe Liste zweimal im selben Zug ist ein Aufruf, nicht zwei', async () => {
    // Der Wiederholungsschutz im Transport. Er darf den Plan nicht kosten,
    // wenn der Server das komplette tool_calls Feld noch einmal schickt.
    const t = await turn(
      callLine('todo_write', { todos: PLAN_MID }),
      callLine('todo_write', { todos: PLAN_MID }),
      doneLine('stop'),
    )
    expect(t.toolCalls).toHaveLength(1)
  })

  it('eine ganz neue Liste setzt den Balken zurueck, und das ist der Vertrag', async () => {
    // "sometimes restarts at 0": `todo_write` ERSETZT die Liste ganz, das
    // steht so in der Werkzeugbeschreibung und im Speicher. Schickt das Modell
    // seinen Plan von vorn, faellt der Balken auf 0. Der Speicher tut genau,
    // was ihm gesagt wurde. Hier festgehalten, damit niemand den Rueckfall
    // spaeter im Reduzierer sucht.
    writeTodos(CONV, PLAN_MID)
    expect(openPlanGap(useTodoStore.getState().getTodos(CONV))?.done).toBe(1)
    writeTodos(CONV, PLAN_START)
    expect(openPlanGap(useTodoStore.getState().getTodos(CONV))?.done).toBe(0)
  })
})

describe('ein Zug, den das Modell nie zu Ende schreiben konnte', () => {
  it('der Transport meldet den Abschnitt, statt ihn wegzuwerfen', async () => {
    // Genau die Zeile, die Ollama schickt, wenn num_predict oder num_ctx alle
    // sind: Text angefangen, Werkzeugaufruf nie geschickt.
    const t = await turn(
      JSON.stringify({ message: { content: 'Now I will update the plan and' }, done: false }),
      doneLine('length'),
    )
    expect(t.toolCalls).toHaveLength(0)
    expect(t.doneReason, 'der abgeschnittene Zug sieht aus wie ein fertiger').toBe('length')
  })

  it('ein sauberer Schluss bleibt ein sauberer Schluss', async () => {
    const t = await turn(callLine('file_read', { path: 'a.ts' }), doneLine('stop'))
    expect(t.doneReason).toBe('stop')
    expect(codexCutoffNote(t.doneReason, { done: 1, total: 2, next: 'rewrite the token loop' })).toBeNull()
  })

  it('der Nutzer liest, warum der Lauf auf seinem Schritt stehenblieb', () => {
    const note = codexCutoffNote('length', { done: 1, total: 2, next: 'rewrite the token loop' })
    expect(note, 'ein abgeschnittener Zug endet weiter wortlos').not.toBeNull()
    expect(note).toContain('rewrite the token loop')
    expect(note).toContain('1 of 2')
    // Englisch, wie jede Meldung in der Oberflaeche.
    expect(note).toMatch(/Max Tokens|context/)
  })

  it('ohne offenen Plan sagt derselbe Satz nichts ueber Schritte', () => {
    const note = codexCutoffNote('length', null)
    expect(note).not.toBeNull()
    expect(note).not.toContain('of 2')
  })

  it('die Schleife schreibt den Satz hin, bevor sie den Lauf beendet', () => {
    // Quelltextrechnung: `sendInstruction` steckt in einem `useCallback`, den
    // kein Test von aussen aufruft. Geprueft wird genau die Reihenfolge, an
    // der es haengt: der Satz muss VOR dem `break` stehen, sonst endet der
    // Lauf wieder wortlos.
    const raw = readFileSync(resolve(__dirname, '..', '..', 'useCodex.ts'), 'utf8')
    const leer = raw.indexOf('if (toolCalls.length === 0)')
    expect(leer, 'die Weiche ohne Werkzeugaufruf ist verschwunden').toBeGreaterThan(0)
    const zweig = raw.slice(leer, raw.indexOf("break-no-toolcalls", leer))
    expect(zweig, 'der abgeschnittene Zug endet wieder wortlos').toContain('codexCutoffNote')
    // R2-17: es sind DREI Transporte, und der dritte setzte den Grund nie.
    // Ein Prompt-Transport schneidet den Zug genauso mitten im `<tool_call>`
    // ab; ohne diese Zeile stand die Variable auf undefined und der Lauf
    // endete wortlos, obwohl der Grund vorlag.
    for (const quelle of [
      'turnFinishReason = turn.doneReason',
      'turnFinishReason = turn.finishReason',
      'turnFinishReason = hermesTurn.finishReason',
    ]) {
      expect(raw, `der Transport liefert den Grund, die Schleife nimmt ihn nicht: ${quelle}`)
        .toContain(quelle)
    }
  })
})
