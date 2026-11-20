// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { PipecatClient, RTVIMessage, RTVIMessageType } from '@pipecat-ai/client-js'
import { VoiceTestTransport } from './helpers/voice-transport'
import { DENIED_FOR_MODEL, VoiceToolBridge, errorForModel } from '../voice-tool-bridge'
import type { VoiceToolBridgeOptions, VoiceToolEvent } from '../voice-tool-bridge'
import { ToolRegistry } from '../mcp/tool-registry'
import { DEFAULT_PERMISSIONS } from '../mcp/types'
import type { PermissionLevel } from '../mcp/types'
import type { AgentRunContext } from '../agent-context'
import { createVoiceLoopStore } from '../../stores/voiceLoopStore'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The tool call messages exactly as the voice loop sidecar sends and accepts
// them. Its own suite (tests/test_contract.py) asserts the same file from the
// other side of the wire.
const wire = JSON.parse(readFileSync(resolve(process.cwd(),
  'src-tauri/resources/voice_loop/tests/fixtures/rtvi_tool_messages.json'), 'utf8'))

const bridges: VoiceToolBridge[] = []
afterEach(() => { cleanup(); for (const b of bridges.splice(0)) b.stop() })

function setup(attach = true) {
  const transport = new VoiceTestTransport()
  const client = new PipecatClient({ transport, enableMic: false, enableCam: false })
  const registry = new ToolRegistry()
  const execute = vi.fn(async (_args: Record<string, unknown>, _run?: AgentRunContext, _signal?: AbortSignal) => 'done')
  for (const [name, category] of [['file_write', 'filesystem'], ['web_fetch', 'web']] as const) {
    registry.registerBuiltin({ name, category, source: 'builtin', description: 'Test tool',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }, execute)
  }
  const store = createVoiceLoopStore('local', 'assistant')
  const parent = new AbortController()
  const run: AgentRunContext = { token: 'voice-test', chatId: 'chat-1', conversationId: 'chat-1', workspace: null,
    artifactMode: false, readOnlyShellTurn: false, mode: null, artifacts: [], abortSignal: parent.signal }
  const permissions = { categories: { ...DEFAULT_PERMISSIONS }, overrides: {} as Record<string, PermissionLevel> }
  const options: VoiceToolBridgeOptions = { client, registry, run, store, offeredTools: ['file_write', 'web_fetch'], permissions: () => permissions }
  const bridge = attach ? new VoiceToolBridge(options) : null
  if (bridge) bridges.push(bridge)
  const call = (id = 'call-1', name = 'file_write', args: Record<string, unknown> = { value: 'hello' }) =>
    transport.receive(new RTVIMessage(RTVIMessageType.LLM_FUNCTION_CALL_IN_PROGRESS, { tool_call_id: id, function_name: name, arguments: args }))
  return { transport, client, execute, store, parent, run, permissions, options, bridge, call }
}

it('uses actual SDK events and result envelopes, then executes a permitted read in its run', async () => {
  const s = setup()
  s.call('read-1', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(s.execute).toHaveBeenCalledTimes(1)
  expect(s.execute.mock.calls[0][1]?.conversationId).toBe('chat-1')
  expect(s.transport.sent[0]).toMatchObject({ label: 'rtvi-ai', type: 'llm-function-call-result',
    data: { tool_call_id: 'read-1', result: { status: 'completed', text: 'done' } } })
})

it('answers the sidecar\'s real in-progress message with the exact result message it accepts', async () => {
  const s = setup()
  s.transport.receive(wire.in_progress)
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(s.execute).toHaveBeenCalledTimes(1)
  expect(s.execute.mock.calls[0][0]).toEqual(wire.in_progress.data.arguments)
  const { label, type, data } = s.transport.sent[0]
  expect({ label, type, data }).toEqual(wire.result)
  // The sidecar then reports the call as stopped. That is not a cancellation.
  s.transport.receive(wire.stopped_completed)
  expect(s.store.getState().status).toBe('connected')
})

it('aborts a running tool on the sidecar\'s real cancelled message', async () => {
  const s = setup()
  let signal: AbortSignal | undefined
  s.execute.mockImplementation(async (_args, _run, abort) => {
    signal = abort
    return new Promise((done) => abort!.addEventListener('abort', () => done('cancelled'), { once: true }))
  })
  s.transport.receive(wire.in_progress)
  await waitFor(() => expect(signal).toBeDefined())
  s.transport.receive(wire.stopped_cancelled)
  await waitFor(() => expect(signal!.aborted).toBe(true))
  expect(s.store.getState().status).toBe('connected')
})

it('finishes what the model needs for its answer before the result goes out, and sends the result even when that fails', async () => {
  const order: string[] = []
  const s = setup(false)
  s.execute.mockImplementation(async () => { order.push('tool'); return 'done' })
  let fail = false
  const bridge = new VoiceToolBridge({ ...s.options, beforeResult: async (name) => {
    await new Promise((done) => setTimeout(done, 20))
    order.push(`before:${name}:${s.transport.sent.length}`)
    if (fail) throw new Error('engine did not come back')
  } })
  bridges.push(bridge)
  s.call('read-1', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(order).toEqual(['tool', 'before:web_fetch:0'])
  fail = true
  s.call('read-2', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(2))
  expect(s.transport.sent[1]).toMatchObject({ data: { tool_call_id: 'read-2', result: { status: 'completed' } } })
  expect(s.store.getState().status).toBe('connected')
})

it('requires confirmation and does not execute a duplicate call twice', async () => {
  const s = setup()
  s.call(); s.call()
  await waitFor(() => expect(s.store.getState().pendingApproval?.name).toBe('file_write'))
  expect(s.execute).not.toHaveBeenCalled()
  s.bridge!.answer(true)
  await waitFor(() => expect(s.execute).toHaveBeenCalledTimes(1))
  s.call()
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(s.execute).toHaveBeenCalledTimes(1)
})

it('stops on reuse of a call ID with different arguments', async () => {
  const s = setup()
  s.call(); s.call('call-1', 'file_write', { value: 'changed' })
  expect(s.store.getState().status).toBe('error')
  await Promise.resolve()
  expect(s.execute).not.toHaveBeenCalled()
})

for (const reason of ['blocked', 'not-offered', 'invalid-schema', 'denied', 'revoked', 'read-only'] as const) {
  it(`does not dispatch a ${reason} call`, async () => {
    const s = setup()
    if (reason === 'blocked') s.permissions.categories.filesystem = 'blocked'
    if (reason === 'read-only') s.run.readOnlyShellTurn = true
    s.call('call-1', reason === 'not-offered' ? 'shell_execute' : 'file_write', reason === 'invalid-schema' ? {} : { value: 'x' })
    if (reason === 'denied' || reason === 'revoked') {
      await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
      if (reason === 'revoked') s.permissions.categories.filesystem = 'blocked'
      s.bridge!.answer(reason === 'revoked')
    }
    await waitFor(() => expect(s.transport.sent).toHaveLength(1))
    expect(s.execute).not.toHaveBeenCalled()
  })
}

it('parent stop clears approvals and prevents queued work and late results', async () => {
  const s = setup()
  s.call(); s.call('call-2', 'web_fetch')
  await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
  s.parent.abort(); s.bridge!.answer(true)
  await Promise.resolve()
  expect(s.store.getState().pendingApproval).toBeNull()
  expect(s.store.getState().status).toBe('stopped')
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.transport.sent).toHaveLength(0)
})

it('honors per-call cancellation while waiting for approval', async () => {
  const s = setup()
  s.call()
  await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
  s.transport.receive(new RTVIMessage(RTVIMessageType.LLM_FUNCTION_CALL_STOPPED, { tool_call_id: 'call-1', cancelled: true }))
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.store.getState().pendingApproval).toBeNull()
})

it('forwards stop to an already running tool', async () => {
  const s = setup()
  let signal: AbortSignal | undefined
  s.execute.mockImplementation(async (_args, _run, abort) => {
    signal = abort
    return new Promise((resolve) => abort!.addEventListener('abort', () => resolve('cancelled'), { once: true }))
  })
  s.call('read-1', 'web_fetch')
  await waitFor(() => expect(signal).toBeDefined())
  s.bridge!.stop()
  expect(signal!.aborted).toBe(true)
  await Promise.resolve()
  expect(s.transport.sent).toHaveLength(0)
})

it('never enables tools in Live mode and bounds oversized arguments', () => {
  const live = setup()
  live.store.setState({ mode: 'live' }); live.call()
  expect(live.store.getState().status).toBe('error')
  const large = setup()
  large.call('call-1', 'file_write', { value: 'x'.repeat(17000) })
  expect(large.store.getState().status).toBe('error')
  expect(large.execute).not.toHaveBeenCalled()
})

it('requires confirmation for mutations even when the category is auto in a supervised session', async () => {
  const s = setup()
  s.permissions.categories.filesystem = 'auto'
  s.call()
  await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
  expect(s.execute).not.toHaveBeenCalled()
  s.bridge!.answer(false)
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
})

it('fails closed when the inbound queue exceeds its bound', async () => {
  const s = setup()
  for (let i = 0; i < 17; i++) s.call(`call-${i}`)
  expect(s.store.getState().status).toBe('error')
  await Promise.resolve()
  expect(s.execute).not.toHaveBeenCalled()
})

it('does not let an old bridge cleanup overwrite a replacement session store', async () => {
  const s = setup()
  s.call()
  await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
  s.bridge!.stop()
  const next = new VoiceToolBridge(s.options)
  bridges.push(next)
  s.call('next-call')
  await waitFor(() => expect(s.store.getState().pendingApproval?.id).toBe('next-call'))
  expect(s.store.getState().generation).toBe(2)
  expect(s.store.getState().status).toBe('connected')
  expect(s.store.getState().currentTool).toBe('file_write')
})

// Cloud models choose their own call ids. The id stays the identity of the
// call on the wire, the app works with a tame alias (lib/voice/call-ids.ts).
for (const wireId of ['functions.web_fetch:0', 'call_abc|fc_123', 'toolu/01:A B', 'chatcmpl-tool-ü', 'x'.repeat(300)]) {
  it(`runs a call whose id is ${JSON.stringify(wireId.slice(0, 24))} and answers under that same id`, async () => {
    const s = setup()
    s.call(wireId, 'web_fetch')
    await waitFor(() => expect(s.transport.sent).toHaveLength(1))
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect(s.store.getState().status).toBe('connected')
    expect(s.transport.sent[0].data).toMatchObject({ tool_call_id: wireId, result: { status: 'completed', text: 'done' } })
  })
}

it('does not run a call twice when an id with unusual characters arrives twice', async () => {
  const s = setup()
  s.call('functions.web_fetch:0', 'web_fetch'); s.call('functions.web_fetch:0', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  await new Promise((done) => setTimeout(done, 20))
  expect(s.execute).toHaveBeenCalledTimes(1)
  expect(s.transport.sent).toHaveLength(1)
  expect(s.store.getState().status).toBe('connected')
})

it('still stops when an id with unusual characters comes back with different arguments', async () => {
  const s = setup()
  s.call('functions.file_write:0'); s.call('functions.file_write:0', 'file_write', { value: 'changed' })
  expect(s.store.getState().status).toBe('error')
  await Promise.resolve()
  expect(s.execute).not.toHaveBeenCalled()
})

it('keeps two ids apart that differ only in characters outside the tame alphabet', async () => {
  const s = setup()
  s.call('call:1', 'web_fetch', { value: 'a' }); s.call('call.1', 'web_fetch', { value: 'b' })
  await waitFor(() => expect(s.transport.sent).toHaveLength(2))
  expect(s.execute).toHaveBeenCalledTimes(2)
  expect(s.transport.sent.map((m) => (m.data as { tool_call_id: string }).tool_call_id)).toEqual(['call:1', 'call.1'])
})

for (const bad of ['', 'x'.repeat(513), 7, null] as const) {
  it(`stops on a call id that cannot be one (${typeof bad === 'string' ? `${bad.length} characters` : String(bad)})`, async () => {
    const s = setup()
    s.transport.receive(new RTVIMessage(RTVIMessageType.LLM_FUNCTION_CALL_IN_PROGRESS,
      { tool_call_id: bad, function_name: 'web_fetch', arguments: { value: 'x' } }))
    expect(s.store.getState().status).toBe('error')
    await Promise.resolve()
    expect(s.execute).not.toHaveBeenCalled()
  })
}

it('reports approval, start and end of a call to its listener, in that order', async () => {
  const events: VoiceToolEvent[] = []
  const s = setup(false)
  const bridge = new VoiceToolBridge({ ...s.options, onCall: (event) => events.push(event) })
  bridges.push(bridge)
  s.call('functions.file_write:0')
  await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
  expect(events.map((e) => e.type)).toEqual(['approval'])
  expect(s.execute).not.toHaveBeenCalled()
  bridge.answer(true)
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(events.map((e) => e.type)).toEqual(['approval', 'started', 'finished'])
  // One alias for the whole life of the call, from the tame alphabet.
  expect(new Set(events.map((e) => e.id)).size).toBe(1)
  expect(events[0].id).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(events[2]).toMatchObject({ type: 'finished', status: 'completed', result: 'done', name: 'file_write' })
})

it('reports a denied call as rejected and a throwing listener does not stop it', async () => {
  const events: VoiceToolEvent[] = []
  const s = setup(false)
  const bridge = new VoiceToolBridge({ ...s.options, onCall: (event) => { events.push(event); throw new Error('listener') } })
  bridges.push(bridge)
  s.call()
  await waitFor(() => expect(s.store.getState().pendingApproval).not.toBeNull())
  bridge.answer(false)
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(s.execute).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'rejected', durationMs: 0 })
  expect(s.store.getState().status).toBe('connected')
  // The model hears that it was the user's no. Told only "did not complete",
  // it wrote the same file through the shell instead (real Windows build).
  expect(JSON.stringify(s.transport.sent[0])).toContain('The user denied this tool call. Do not try it again and do not work around it')
})

it('tells the model why a call failed', () => {
  expect(errorForModel('rejected', 'User rejected tool call')).toBe(DENIED_FOR_MODEL)
  expect(errorForModel('rejected', undefined)).toBe(DENIED_FOR_MODEL)
  expect(errorForModel('rejected', 'Aborted before dispatch')).toBe('Aborted before dispatch')
  expect(errorForModel('failed', 'Invalid arguments: path is missing')).toBe('Invalid arguments: path is missing')
  expect(errorForModel('failed', '')).toBe('The tool did not complete.')
})

it('passes interim reports of a long tool on and keeps the call open', async () => {
  const s = setup()
  let finish: (text: string) => void = () => {}
  s.execute.mockImplementation(async (_args, run) => {
    run?.onToolProgress?.('Step 1: Click at 500, 500.')
    run?.onToolProgress?.('x'.repeat(900))
    return new Promise<string>((done) => { finish = done })
  })
  s.call('long-1', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(2))
  expect(s.transport.sent[0]).toMatchObject({ type: 'llm-function-call-result',
    data: { tool_call_id: 'long-1', function_name: 'web_fetch', result: { status: 'progress', text: 'Step 1: Click at 500, 500.' } } })
  expect((s.transport.sent[1].data as { result: { text: string } }).result.text).toHaveLength(500)
  finish('Saved.')
  await waitFor(() => expect(s.transport.sent).toHaveLength(3))
  expect(s.transport.sent[2]).toMatchObject({ data: { tool_call_id: 'long-1', result: { status: 'completed', text: 'Saved.' } } })
})

it('sends no interim report for a call that is over', async () => {
  const s = setup()
  let late: ((text: string) => void) | undefined
  s.execute.mockImplementation(async (_args, run) => { late = run?.onToolProgress; return 'done' })
  s.call('quick-1', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  late?.('Step 9')
  expect(s.transport.sent).toHaveLength(1)
})

it('gives a named tool its own time limit', async () => {
  vi.useFakeTimers()
  try {
    const transport = new VoiceTestTransport()
    const s = setup(false)
    const bridge = new VoiceToolBridge({ ...s.options, client: new PipecatClient({ transport, enableMic: false, enableCam: false }),
      toolTimeoutMs: 1000, toolTimeouts: { web_fetch: 5000 } })
    bridges.push(bridge)
    s.execute.mockImplementation(async (_args, _run, abort) =>
      new Promise((done) => abort!.addEventListener('abort', () => done('late'), { once: true })))
    transport.receive(new RTVIMessage(RTVIMessageType.LLM_FUNCTION_CALL_IN_PROGRESS, { tool_call_id: 'slow', function_name: 'web_fetch', arguments: { value: 'a' } }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(transport.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2500)
    expect(transport.sent).toHaveLength(1)
    expect((transport.sent[0].data as { result: { status: string } }).result.status).not.toBe('completed')
  } finally { vi.useRealTimers() }
})

it('answers a call the switches of the surface rule out as failed, with the reason, and never runs or asks', async () => {
  const s = setup(false)
  const events: VoiceToolEvent[] = []
  const refuse = vi.fn((name: string, args: Record<string, unknown>) => (name === 'file_write' ? `not here: ${String(args.value)}` : null))
  bridges.push(new VoiceToolBridge({ ...s.options, refuse, onCall: (event) => { events.push(event) } }))
  s.call('w-1', 'file_write', { value: '/etc/hosts' })
  await waitFor(() => expect(s.transport.sent).toHaveLength(1))
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.store.getState().pendingApproval).toBeNull()
  expect(s.transport.sent[0]).toMatchObject({ type: 'llm-function-call-result',
    data: { tool_call_id: 'w-1', result: { status: 'failed', error: 'not here: /etc/hosts' } } })
  expect(events.map((event) => event.type)).toEqual(['started', 'finished'])
  expect(events[1]).toMatchObject({ status: 'failed', result: 'not here: /etc/hosts' })
  // A call the switches allow goes its normal way.
  s.call('r-1', 'web_fetch')
  await waitFor(() => expect(s.execute).toHaveBeenCalledTimes(1))
})

it('lets the surface narrow a tool that runs by itself to one that asks, and to one that is blocked', async () => {
  const s = setup(false)
  let level: PermissionLevel = 'confirm'
  bridges.push(new VoiceToolBridge({ ...s.options, narrow: (name, own) => (name === 'web_fetch' ? level : own) }))
  s.call('r-1', 'web_fetch')
  await waitFor(() => expect(s.store.getState().pendingApproval?.name).toBe('web_fetch'))
  expect(s.execute).not.toHaveBeenCalled()
  bridges[0].answer(true)
  await waitFor(() => expect(s.execute).toHaveBeenCalledTimes(1))
  level = 'blocked'
  s.call('r-2', 'web_fetch')
  await waitFor(() => expect(s.transport.sent).toHaveLength(2))
  expect(s.execute).toHaveBeenCalledTimes(1)
})
