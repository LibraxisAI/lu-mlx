/**
 * The client side of the OpenAI Responses API (`/v1/responses`).
 *
 * Two ways to run one turn, one vocabulary coming back:
 *
 * - Inside the desktop app (`isTauri()`) the turn runs in Rust
 *   (`responses_stream`, src-tauri/src/commands/responses.rs): a persistent
 *   WebSocket per session with `previous_response_id` chaining, falling back
 *   to HTTP SSE where the server has no WebSocket mode. Events arrive over a
 *   Tauri `Channel`, Stop is `responses_cancel`.
 * - In a plain browser (`npm run dev`, the tests) the turn is an HTTP SSE or
 *   JSON `fetch`, and `ResponsesWireAccumulator` (responses-wire.ts) turns the
 *   raw events into the SAME `RustResponsesEvent`s the Rust side sends.
 *
 * `chunksFromEvents` is the one consumer of both: it becomes the
 * `ChatStreamChunk`s every provider yields, and every failure becomes a
 * `ProviderError` with an English sentence. House rule (P1, 2026-09-04): no
 * Rust command name ever reaches a chat bubble, so the raw line of a transport
 * failure is translated with the same helpers the Chat Completions path uses.
 */
import { ProviderError, type ChatBilling, type ChatStreamChunk, type ResponsesTransport, type ToolCall } from './types'
import { isRecord } from './wire'
import {
  ResponsesWireAccumulator, parseResponsesErrorBody, parseRustResponsesEvent, responsesUrl,
  type ResponsesRequest, type RustResponsesErrorEvent, type RustResponsesEvent,
} from './responses-wire'
import { isTauri } from '../in-tauri'
import { parseSSEStream } from '../sse'
import { idleAbortGuard, isStreamIdleTimeout } from '../stream-idle'
import { explainEngineTransportMessage } from '../builtin-ensure'
import { repairJson } from '../../lib/tool-call-repair'
import { chatBilling } from '../../lib/flash-ui'
import { parseRetryAfter } from '../../lib/http-status'
import { requestLimitMessage } from '../../lib/request-limit'
import { signalCreditsExhausted } from '../../lib/credits-exhausted'
import { FIRST_REPLY_TIMEOUT } from '../../lib/chat-reply-timeout'
import { isLocalTransportFailure, localBackendUnreachableMessage, remoteBackendUnreachableMessage } from '../../lib/local-backend-transport'
import { log } from '../../lib/logger'

/** How long the channel may still deliver after `responses_stream` returned.
 *  The Rust command sends `eof` itself; this only covers a lost message. */
const EOF_GRACE_MS = 15_000

/** What an error sentence needs to know about the endpoint. */
export interface ResponsesErrorContext {
  /** The provider's display name, as the Chat Completions path names it. */
  providerName: string
  baseUrl: string
  /** The app's own engine (`config.managed`). */
  managed: boolean
  /** A server on this machine or the LAN. */
  lan: boolean
  /** The request went through a proxy that can produce a raw transport line. */
  viaProxy: boolean
  /** LU Cloud books nothing for a refused request. */
  luCloud: boolean
  /** The request carried tools, so a 400/405 about them means "no tool calling". */
  toolsSent: boolean
}

/** The browser path's fetch: plain `fetch`, or `localFetchStream` for a LAN host. */
export type ResponsesFetcher = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>

export interface ResponsesTurnParams {
  baseUrl: string
  body: ResponsesRequest
  headers: Record<string, string>
  transport: ResponsesTransport
  /** One WebSocket and one response chain per session (Rust side only). */
  sessionId?: string
  signal?: AbortSignal
  /** Silence budget between events, ms (0 = off). */
  idleMs: number
  /** Silence budget before the first event, ms (0 = off). */
  firstChunkMs: number
  fetcher: ResponsesFetcher
  context: ResponsesErrorContext
}

// ── Plumbing ────────────────────────────────────────────────────────────────

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function newStreamId(): string {
  const c: { randomUUID?: () => string } | undefined = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A minimal async queue: pushed items in order, then the end. */
class EventQueue<T> {
  private readonly items: T[] = []
  private waiter: ((r: IteratorResult<T, undefined>) => void) | null = null
  private ended = false

  get closed(): boolean {
    return this.ended
  }

  push(item: T): void {
    if (this.ended) return
    const w = this.waiter
    if (w) {
      this.waiter = null
      w({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    const w = this.waiter
    if (w) {
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.items.length > 0) {
      const item = this.items.shift() as T
      return Promise.resolve({ value: item, done: false })
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

function errorEvent(code: string, message: string, retryable = false): RustResponsesErrorEvent {
  return { kind: 'error', status: null, code, message, retry_after_ms: null, retryable, server_raw: null }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '')
}

// ── Desktop path: Rust over a Tauri channel ─────────────────────────────────

async function* eventsViaTauri(p: ResponsesTurnParams): AsyncGenerator<RustResponsesEvent> {
  if (p.signal?.aborted) throw abortError()
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const streamId = newStreamId()
  const queue = new EventQueue<RustResponsesEvent>()
  const channel = new Channel<unknown>()
  channel.onmessage = (raw) => {
    const ev = parseRustResponsesEvent(raw)
    if (!ev) return
    if (ev.kind === 'eof') queue.close()
    else queue.push(ev)
  }

  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    invoke('responses_cancel', { streamId }).catch((err: unknown) => {
      log.warn('[responses] cancel did not reach the backend', { err: messageOf(err) })
    })
    queue.close()
  }
  p.signal?.addEventListener('abort', cancel, { once: true })

  let grace: ReturnType<typeof setTimeout> | undefined
  const call = invoke('responses_stream', {
    req: {
      url: p.baseUrl,
      transport: p.transport,
      bodyJson: JSON.stringify(p.body),
      headers: p.headers,
      streamId,
      sessionId: p.sessionId ?? null,
      idleTimeoutMs: Math.max(0, Math.round(p.idleMs)),
      firstChunkTimeoutMs: Math.max(0, Math.round(p.firstChunkMs)),
    },
    onEvent: channel,
  }).then(
    () => {
      if (!queue.closed) grace = setTimeout(() => queue.close(), EOF_GRACE_MS)
    },
    (err: unknown) => {
      // Only the IPC itself can reject (the command always answers Ok and
      // reports failures as events): an old build without the command, a
      // torn-down window. The raw line names the command, so it stays in
      // the log and the chat gets a code to word.
      log.warn('[responses] the request could not be started', { err: messageOf(err) })
      queue.push(errorEvent('ipc', 'ipc'))
      queue.close()
    },
  )

  let finished = false
  // The consumer stops reading at `completed` or `error`, before `eof`; the
  // turn is over then and needs no cancel.
  let terminal = false
  try {
    for (;;) {
      const r = await queue.next()
      if (r.done) break
      if (r.value.kind === 'completed' || r.value.kind === 'error') terminal = true
      yield r.value
    }
    finished = true
    if (p.signal?.aborted) throw abortError()
  } finally {
    p.signal?.removeEventListener('abort', cancel)
    if (grace !== undefined) clearTimeout(grace)
    // The consumer left early (a repetition stop, a thrown error): the turn
    // on the Rust side must not keep pulling tokens nobody reads.
    if (!finished && !cancelled && !terminal) cancel()
    // Nothing reads the queue any more; a late `eof` must not arm the grace timer.
    queue.close()
    void call
  }
}

// ── Browser path: HTTP SSE / JSON ───────────────────────────────────────────

async function* eventsViaFetch(p: ResponsesTurnParams): AsyncGenerator<RustResponsesEvent> {
  if (p.signal?.aborted) throw abortError()
  const url = responsesUrl(p.baseUrl)
  const guard = idleAbortGuard(p.signal)
  const acc = new ResponsesWireAccumulator('sse')
  let res: Response
  try {
    res = await p.fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: p.body.stream ? 'text/event-stream' : 'application/json', ...p.headers },
      body: JSON.stringify(p.body),
      signal: guard.signal,
    })
  } catch (err) {
    guard.release()
    if (p.signal?.aborted) throw abortError()
    yield errorEvent('transport', `error sending request for url (${url}): ${messageOf(err)}`, true)
    return
  }

  try {
    const billing = chatBilling(res)
    if (billing) yield { kind: 'billing', mode: billing }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      yield parseResponsesErrorBody(res.status, text, parseRetryAfter(res))
      return
    }

    const type = res.headers.get('content-type') ?? ''
    if (!/event-stream/i.test(type)) {
      // A whole response object: the non-streaming answer, or a server that
      // ignored `stream: true`.
      let raw: unknown
      try {
        raw = await res.json()
      } catch {
        yield errorEvent('invalid_response', 'The model server sent an answer that is not a Responses API object.')
        return
      }
      yield* acc.process(raw)
      if (!acc.terminal) yield errorEvent('invalid_response', 'The model server sent an answer that is not a Responses API object.')
      return
    }

    for await (const frame of parseSSEStream(res, { onIdle: guard.abort, idleMs: p.idleMs, firstChunkMs: p.firstChunkMs })) {
      if (frame.data === '[DONE]') {
        yield* acc.finishWithoutTerminal()
        break
      }
      let raw: unknown
      try {
        raw = JSON.parse(frame.data)
      } catch {
        continue
      }
      yield* acc.process(raw, frame.event)
      if (acc.terminal) break
    }
    if (!acc.terminal) {
      yield errorEvent(
        acc.visible ? 'stream_broken' : 'transport',
        acc.visible
          ? 'The stream closed before the answer was complete.'
          : `error sending request for url (${url}): the stream closed before any answer arrived`,
        !acc.visible,
      )
    }
  } catch (err) {
    if (isStreamIdleTimeout(err)) {
      log.warn('provider.stream_idle_timeout', { provider: 'responses', idleMs: err.idleMs })
      yield errorEvent('stream_idle', 'The backend stopped sending data.')
      return
    }
    if (p.signal?.aborted) throw abortError()
    yield errorEvent(
      acc.visible ? 'stream_broken' : 'transport',
      `error sending request for url (${url}): ${messageOf(err)}`,
      !acc.visible,
    )
  } finally {
    guard.release()
  }
}

/** The raw events of one turn, on whichever path this build has. */
export function responsesEvents(p: ResponsesTurnParams): AsyncGenerator<RustResponsesEvent> {
  return isTauri() ? eventsViaTauri(p) : eventsViaFetch(p)
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Rust command names and the proxy prefixes that carry them. */
const RUST_NAMES = /\b(?:responses_(?:stream|cancel|close_session)|proxy_localhost(?:_[a-z_]+)?)\b:?\s*/g

/**
 * One error event as the `ProviderError` the chat layer already knows how to
 * show. Codes follow `OpenAIProvider.parseError` so the agent's retry ladder
 * and the capability memory read a Responses failure exactly like a Chat
 * Completions one.
 */
export function mapResponsesError(ev: RustResponsesErrorEvent, ctx: ResponsesErrorContext): ProviderError {
  const status = ev.status ?? undefined
  const retryAfterMs = ev.retry_after_ms ?? undefined
  const serverCode = ev.code ?? undefined
  let message = ev.message
  let code: string = 'network'

  if (serverCode === 'ipc') {
    return new ProviderError(`${ctx.providerName}: LU could not start this request. Restart LU and try again.`, 'openai', 'network', status)
  }

  if (status === 401 || status === 403) {
    code = 'auth'
    if (!message || /^HTTP \d+/.test(message)) message = `Invalid API key for ${ctx.providerName}. Check Settings > Providers.`
  } else if (status === 429 || serverCode === 'rate_limit_exceeded') {
    code = 'rate_limit'
    message = requestLimitMessage({
      said: /^HTTP \d+/.test(message) ? '' : message,
      retryAfterMs,
      nothingCharged: ctx.luCloud,
    })
  } else if (status === 404) {
    code = 'not_found'
  }

  if (ctx.toolsSent && (status === 405 || ((status === 400 || status === 404 || status === 422) && /\btools?\b|function[_ ]?call/i.test(message)))) {
    code = 'tools_unsupported'
    if (/^HTTP \d+/.test(message)) message = `${ctx.providerName}: this model does not support tools (function calling).`
  }

  if (serverCode === 'model_no_tools') code = 'tools_unsupported'
  else if (serverCode === 'model_no_vision') code = 'vision_unsupported'
  else if (serverCode === 'stalled_runaway') code = 'stalled_runaway'
  else if (serverCode === FIRST_REPLY_TIMEOUT) {
    code = FIRST_REPLY_TIMEOUT
    message = `${ctx.providerName}: ${message}`
  } else if (serverCode === 'credits_exhausted' || serverCode === 'insufficient_quota') {
    code = 'credits_exhausted'
    if (serverCode === 'credits_exhausted') signalCreditsExhausted()
  } else if (serverCode === 'stream_idle' || serverCode === 'stream_broken') {
    message = `${ctx.providerName}: ${message}`
  }

  // A transport failure: the address in a raw line. Last, so a server that
  // answered with real words keeps them.
  if (ctx.managed) {
    const friendly = explainEngineTransportMessage(message, ctx.baseUrl)
    if (friendly) {
      message = friendly
      code = 'network'
    }
  } else if (isLocalTransportFailure(message, ctx.baseUrl)) {
    if (ctx.viaProxy || ctx.lan || serverCode === 'transport') {
      message = ctx.lan
        ? localBackendUnreachableMessage(ctx.providerName, ctx.baseUrl)
        : remoteBackendUnreachableMessage(ctx.providerName, ctx.baseUrl)
      code = 'network'
    }
  }

  // Whatever is left must still not name a Rust command.
  message = message.replace(RUST_NAMES, '').trim() || `${ctx.providerName}: Request failed`
  return new ProviderError(message, 'openai', code, status, undefined, retryAfterMs)
}

// ── Events → chat chunks ────────────────────────────────────────────────────

/** What the turn left behind, for the next turn of the same conversation. */
export interface ResponsesTurnSummary {
  responseId?: string
  transport?: string
  status?: string
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args)
    if (isRecord(parsed)) return parsed
  } catch {
    // repaired below
  }
  const repaired: unknown = repairJson(args)
  return isRecord(repaired) ? repaired : {}
}

function asBilling(mode: string): ChatBilling | undefined {
  return mode === 'flash' || mode === 'credits' ? mode : undefined
}

interface CallProgress {
  itemId?: string
  callId: string
  name: string
  args: string
  done: boolean
}

/**
 * The events of one turn as `ChatStreamChunk`s: reasoning as `thinking`, text
 * as `content`, a call being written as `toolProgress`, and one final
 * `done: true` chunk with the finished calls and the token counts. A stream
 * that went quiet or broke off AFTER the answer began ends as
 * `finishReason: 'disconnect'`, the way the Chat Completions path ends it.
 */
export async function* chunksFromEvents(
  events: AsyncIterable<RustResponsesEvent>,
  ctx: ResponsesErrorContext,
  summary?: ResponsesTurnSummary,
): AsyncGenerator<ChatStreamChunk> {
  const calls: CallProgress[] = []
  let billing: ChatBilling | undefined
  let visible = false

  // A delta names its call by `call_id`, by `item_id`, or (some servers) by
  // neither, and then belongs to the call still being written.
  const callFor = (itemId: string | null, callId: string | null, name?: string): CallProgress => {
    let c = calls.find((x) => (!!callId && x.callId === callId) || (!!itemId && x.itemId === itemId))
    if (!c && !callId && !itemId) {
      for (let i = calls.length - 1; i >= 0 && !c; i--) if (!calls[i].done) c = calls[i]
    }
    if (!c) {
      c = { itemId: itemId || undefined, callId: callId || '', name: name ?? '', args: '', done: false }
      calls.push(c)
    }
    if (itemId && !c.itemId) c.itemId = itemId
    if (callId && !c.callId) c.callId = callId
    if (name && !c.name) c.name = name
    return c
  }

  // An empty id would put an empty tool_call_id into the follow-up turn and
  // 422 it (flushToolCalls in openai-provider.ts has the same fallback).
  const toolCalls = (): ToolCall[] | undefined => {
    const out = calls
      .filter((c) => c.name)
      .map((c, i) => ({ id: c.callId || c.itemId || `call_${i}`, function: { name: c.name, arguments: parseArgs(c.args) } }))
    return out.length > 0 ? out : undefined
  }

  const doneChunk = (finishReason: string, usage?: { input: number | null; output: number | null; cached: number | null }): ChatStreamChunk => ({
    content: '',
    toolCalls: toolCalls(),
    done: true,
    finishReason,
    promptEvalCount: usage?.input || undefined,
    evalCount: usage?.output || undefined,
    cachedPromptCount: usage?.cached || undefined,
    billing,
  })

  for await (const ev of events) {
    switch (ev.kind) {
      case 'created':
        if (summary) {
          if (ev.response_id) summary.responseId = ev.response_id
          summary.transport = ev.transport
        }
        break
      case 'billing':
        billing = asBilling(ev.mode) ?? billing
        break
      case 'reasoning_delta':
        if (ev.delta) {
          visible = true
          yield { content: '', thinking: ev.delta, done: false }
        }
        break
      case 'text_delta':
        if (ev.delta) {
          visible = true
          yield { content: ev.delta, done: false }
        }
        break
      case 'function_call_started': {
        visible = true
        const c = callFor(ev.item_id, ev.call_id, ev.name)
        if (c.name) yield { content: '', toolProgress: { name: c.name, argsChars: c.args.length }, done: false }
        break
      }
      case 'function_call_args_delta': {
        visible = true
        const c = callFor(ev.item_id, ev.call_id)
        c.args += ev.delta
        if (c.name) yield { content: '', toolProgress: { name: c.name, argsChars: c.args.length }, done: false }
        break
      }
      case 'function_call_done': {
        visible = true
        const c = callFor(ev.item_id, ev.call_id, ev.name)
        if (ev.call_id) c.callId = ev.call_id
        if (ev.name) c.name = ev.name
        c.args = ev.arguments
        c.done = true
        break
      }
      case 'reasoning_item_done':
        break
      case 'completed':
        if (summary) {
          summary.responseId = ev.response_id ?? summary.responseId
          summary.transport = ev.transport
          summary.status = ev.status
        }
        yield doneChunk(ev.finish_reason ?? (calls.length > 0 ? 'tool_calls' : 'stop'), {
          input: ev.input_tokens,
          output: ev.output_tokens,
          cached: ev.cached_tokens,
        })
        return
      case 'error':
        if (ev.code === 'stream_idle' || (visible && ev.code === 'stream_broken')) {
          log.warn('[responses] stream ended without a completion', { code: ev.code })
          yield doneChunk('disconnect')
          return
        }
        throw mapResponsesError(ev, ctx)
      case 'eof':
        break
    }
  }
  // The events ended without `completed` or an error: a cut. The browser
  // path always names it; this covers a lost channel message.
  yield doneChunk('disconnect')
}

/** One streaming turn: raw events on this build's path, as chat chunks. */
export function streamResponsesTurn(p: ResponsesTurnParams, summary?: ResponsesTurnSummary): AsyncGenerator<ChatStreamChunk> {
  return chunksFromEvents(responsesEvents(p), p.context, summary)
}

export interface ResponsesToolsResult {
  content: string
  toolCalls: ToolCall[]
  thinking?: string
  promptEvalCount?: number
  evalCount?: number
  cachedPromptCount?: number
  billing?: ChatBilling
  finishReason?: string
}

/**
 * A whole turn, collected: the `chatWithTools` contract. A tool turn runs on
 * the same transport as a stream (a WebSocket turn is always a stream), so
 * one code path serves both; the provider puts its own guards in between.
 */
export async function collectResponsesChunks(chunks: AsyncIterable<ChatStreamChunk>): Promise<ResponsesToolsResult> {
  let content = ''
  let thinking = ''
  let done: ChatStreamChunk | undefined
  for await (const chunk of chunks) {
    if (chunk.done) {
      done = chunk
      break
    }
    content += chunk.content
    if (chunk.thinking) thinking += chunk.thinking
  }
  return {
    content,
    toolCalls: done?.toolCalls ?? [],
    thinking: thinking || undefined,
    promptEvalCount: done?.promptEvalCount,
    evalCount: done?.evalCount,
    cachedPromptCount: done?.cachedPromptCount,
    billing: done?.billing,
    finishReason: done?.finishReason,
  }
}
