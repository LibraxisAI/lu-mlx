/**
 * Bug hunt 01.10.2026 (A2). A step that runs into the token limit while it is
 * writing a tool call ends with finish_reason 'length' and a call whose
 * arguments stop halfway. The provider repairs what it gets, so the cut call
 * came out as a call with arguments the model never wrote, and the agent ran
 * it. Cut right after one element of a list, the same repair hands on a valid
 * call with the rest of the list missing: a file_edit that applies its first
 * edit and never the one after it.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProviderConfig } from '../../api/providers/types'
import { dropCutOffCall } from '../codex/turn-cutoff'

const backendMock = (respond: () => Response) => ({
  isTauri: () => false,
  localFetch: vi.fn(async () => respond()),
  localFetchStream: vi.fn(async () => respond()),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  backendCall: vi.fn(),
  isPrivateOrLanHost: () => false,
  isDirectFetchAllowed: () => false,
  hostnameOf: (url: string) => new URL(url).hostname,
  ensureProxyAllowsHost: vi.fn(),
})

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

/** A native stream: one finished read, then an edit of two steps that the
 *  limit cut right after the first. */
const MIDWAY = '{"path":"auth.ts","edits":[{"old_string":"checkToken(req)","new_string":"checkToken(req, { strict: false })"},{"old_string":"strict: false","new_str'
const AFTER_FIRST = '{"path":"auth.ts","edits":[{"old_string":"checkToken(req)","new_string":"checkToken(req, { strict: false })"}'

async function cutTurn(editArgs = MIDWAY) {
  vi.resetModules()
  const body =
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'file_read', arguments: '{"path":"a.ts"}' } }] } }] }) +
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'file_edit', arguments: editArgs } }] } }] }) +
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) +
    'data: [DONE]\n\n'
  vi.doMock('../../api/backend', () => backendMock(() => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })))
  const { OpenAIProvider } = await import('../../api/providers/openai-provider')
  const config: ProviderConfig = { id: 'openai', name: 'LU Cloud', enabled: true, apiKey: 'x', baseUrl: 'https://lu-labs.test/api/inference/v1', isLocal: false }
  let last: { toolCalls?: { function: { name: string; arguments: Record<string, unknown> } }[]; finishReason?: string } = {}
  for await (const chunk of new OpenAIProvider(config).chatStream('m', [{ role: 'user', content: 'go' }])) {
    if (chunk.done) last = chunk
  }
  return last
}

describe('a turn cut off by the token limit', () => {
  it('reaches the agent as a call with arguments the model never wrote', async () => {
    const turn = await cutTurn()
    expect(turn.finishReason).toBe('length')
    const edit = turn.toolCalls!.find((c) => c.function.name === 'file_edit')!
    // The repair closed the brackets around the first edit and handed THAT on
    // as the whole argument object: no path, one edit of two. It ran, failed
    // or half applied, and the model sent the same long call into the same
    // limit again.
    expect(edit.function.arguments).toEqual({ old_string: 'checkToken(req)', new_string: 'checkToken(req, { strict: false })' })
  })

  it('or as a valid call with the rest of its list missing', async () => {
    const turn = await cutTurn(AFTER_FIRST)
    const edit = turn.toolCalls!.find((c) => c.function.name === 'file_edit')!
    // A valid edit that loosens the check, without the second edit that was
    // going to tighten it again.
    expect(edit.function.arguments).toEqual({
      path: 'auth.ts',
      edits: [{ old_string: 'checkToken(req)', new_string: 'checkToken(req, { strict: false })' }],
    })
    expect(dropCutOffCall(turn.toolCalls!, turn.finishReason).dropped).toBe(edit)
  })

  it('runs the finished calls and drops the one that was cut', async () => {
    const turn = await cutTurn()
    const { calls, dropped } = dropCutOffCall(turn.toolCalls!, turn.finishReason)
    expect(calls.map((c) => c.function.name)).toEqual(['file_read'])
    expect(dropped!.function.name).toBe('file_edit')
  })

  it('leaves a turn that ended on its own alone', () => {
    const calls = [{ id: 'a' }, { id: 'b' }]
    expect(dropCutOffCall(calls, 'tool_calls')).toEqual({ calls, dropped: null })
    expect(dropCutOffCall(calls, 'stop')).toEqual({ calls, dropped: null })
    expect(dropCutOffCall(calls, undefined)).toEqual({ calls, dropped: null })
    expect(dropCutOffCall([], 'length')).toEqual({ calls: [], dropped: null })
  })

  it('both loops drop it before anything runs, the Agent loop after its loose fallback', () => {
    const agent = readFileSync(resolve(__dirname, '../useAgentChat.ts'), 'utf8')
    const at = agent.indexOf('dropCutOffCall(toolCalls, turnFinishReason)')
    expect(at).toBeGreaterThan(agent.indexOf('parseLooseToolCalls(turnContent, knownToolNames)'))
    expect(at).toBeLessThan(agent.indexOf('// Over-loop guard'))
    expect(at).toBeLessThan(agent.indexOf('let isFinalTurn = toolCalls.length === 0'))

    const code = readFileSync(resolve(__dirname, '../useCodex.ts'), 'utf8')
    const cat = code.indexOf('dropCutOffCall(toolCalls, turnFinishReason)')
    expect(cat).toBeGreaterThan(code.indexOf('turnFinishReason = hermesTurn.finishReason'))
    expect(cat).toBeLessThan(code.indexOf('        if (toolCalls.length === 0) {'))
  })
})
