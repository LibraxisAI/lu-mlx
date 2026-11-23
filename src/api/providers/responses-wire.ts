/**
 * The OpenAI Responses API (`/v1/responses`) on the wire: the request this app
 * sends, and checked parsers for everything that comes back (SSE events,
 * WebSocket error frames, a whole non-streaming response object, and the
 * events the Rust transport forwards over its Tauri channel).
 *
 * A LEAF on purpose: this file imports nothing, not even `./wire`. The
 * provider, its tests and the Rust event mirror all depend on it, and a leaf
 * cannot be pulled into an import cycle by any of them. The few guards it
 * needs are its own four lines.
 *
 * `ResponsesWireAccumulator` is the TypeScript twin of the Rust
 * `ResponsesEventAccumulator` (src-tauri/src/commands/responses.rs): the
 * browser and test path turns raw Responses events into the SAME event
 * vocabulary the Rust transport sends, so one consumer
 * (responses-client.ts) serves both paths and they cannot drift apart in
 * what they show.
 */

// ── Guards ──────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function objs(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isObj) : []
}

function nonEmpty(v: unknown): string | undefined {
  const s = str(v)
  return s ? s : undefined
}

// ── Request ─────────────────────────────────────────────────────────────────

/** The message shape this module reads. `ChatMessage` (types.ts) fits it. */
export interface ResponsesWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: { data: string; mimeType: string }[]
  tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[]
  tool_call_id?: string
}

/** The tool shape this module reads. `ToolDefinition` (types.ts) fits it. */
export interface ResponsesWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown }
}

export type ResponsesInputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

export type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponsesInputContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters?: unknown
}

export interface ResponsesRequest {
  model: string
  instructions?: string
  input: ResponsesInputItem[]
  tools?: ResponsesFunctionTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  reasoning?: { effort: string; summary?: 'auto' | 'concise' | 'detailed' }
  stream: boolean
  store?: boolean
  include?: string[]
  text?: { format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: boolean } }
  previous_response_id?: string
  /** Extension fields for a server on this machine or the LAN (top_k, min_p, …). */
  [extra: string]: unknown
}

export interface BuildResponsesParams {
  model: string
  messages: ResponsesWireMessage[]
  tools?: ResponsesWireTool[]
  stream: boolean
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  /** The thinking knob as the provider computed it ('none' and 'minimal' = off). */
  reasoningEffort?: string
  jsonSchema?: Record<string, unknown>
  store?: boolean
  /** Extension fields, added only where the request has no field of that name. */
  extra?: Record<string, unknown>
}

/**
 * The `/v1/responses` request for one turn.
 *
 * System messages become `instructions` (joined), not `system` input items:
 * a strict server (and many local chat templates behind a Responses
 * endpoint) accept exactly one system turn, first. User images travel as
 * `input_image` data URLs, an assistant turn's tool calls as `function_call`
 * items after its text, a `tool` message as `function_call_output`.
 */
export function buildResponsesRequest(p: BuildResponsesParams): ResponsesRequest {
  const system: string[] = []
  const input: ResponsesInputItem[] = []
  let unnamedCalls = 0
  for (const m of p.messages) {
    switch (m.role) {
      case 'system':
        if (m.content.trim()) system.push(m.content)
        break
      case 'user': {
        const parts: ResponsesInputContentPart[] = []
        if (m.content) parts.push({ type: 'input_text', text: m.content })
        for (const img of m.images ?? []) {
          parts.push({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.data}` })
        }
        if (parts.length === 0) parts.push({ type: 'input_text', text: '' })
        input.push({ type: 'message', role: 'user', content: parts })
        break
      }
      case 'assistant': {
        if (m.content) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
        }
        for (const tc of m.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: tc.id || `call_${unnamedCalls++}`,
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments ?? {}),
          })
        }
        break
      }
      case 'tool':
        input.push({ type: 'function_call_output', call_id: m.tool_call_id || 'call_0', output: m.content })
        break
    }
  }

  const req: ResponsesRequest = { model: p.model, input, stream: p.stream }
  if (system.length > 0) req.instructions = system.join('\n\n')
  if (p.tools && p.tools.length > 0) {
    req.tools = p.tools.map((t) => {
      const tool: ResponsesFunctionTool = { type: 'function', name: t.function.name }
      if (t.function.description !== undefined) tool.description = t.function.description
      if (t.function.parameters !== undefined) tool.parameters = t.function.parameters
      return tool
    })
    req.tool_choice = 'auto'
  }
  if (p.temperature !== undefined) req.temperature = p.temperature
  if (p.topP !== undefined) req.top_p = p.topP
  if (p.maxOutputTokens !== undefined && p.maxOutputTokens > 0) req.max_output_tokens = p.maxOutputTokens
  if (p.reasoningEffort) {
    // A summary only where thinking is on: it is what fills the thinking
    // panel, and asking for one with the knob off is a 400 on some servers.
    const off = p.reasoningEffort === 'none' || p.reasoningEffort === 'minimal'
    req.reasoning = off ? { effort: p.reasoningEffort } : { effort: p.reasoningEffort, summary: 'auto' }
  }
  if (p.jsonSchema) {
    req.text = { format: { type: 'json_schema', name: 'answer', schema: p.jsonSchema, strict: false } }
  }
  if (p.store !== undefined) req.store = p.store
  for (const [k, v] of Object.entries(p.extra ?? {})) {
    if (v !== undefined && !(k in req)) req[k] = v
  }
  return req
}

/** The HTTP endpoint for a provider base URL (`…/v1` → `…/v1/responses`). */
export function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/responses$/.test(trimmed) ? trimmed : `${trimmed}/responses`
}

// ── The event vocabulary (mirror of the Rust `ResponsesStreamEvent`) ────────

export type RustResponsesEvent =
  | { kind: 'created'; response_id: string | null; model: string | null; transport: string }
  | { kind: 'text_delta'; delta: string; item_id: string | null }
  | { kind: 'reasoning_delta'; delta: string; item_id: string | null; summary: boolean }
  | { kind: 'function_call_started'; item_id: string | null; call_id: string; name: string }
  | { kind: 'function_call_args_delta'; item_id: string | null; call_id: string | null; delta: string }
  | { kind: 'function_call_done'; item_id: string | null; call_id: string; name: string; arguments: string }
  | { kind: 'reasoning_item_done'; item_id: string; encrypted_content: string | null; summary: string[] }
  | {
      kind: 'completed'
      response_id: string | null
      model: string | null
      status: string
      finish_reason: string | null
      input_tokens: number | null
      output_tokens: number | null
      cached_tokens: number | null
      transport: string
    }
  | { kind: 'billing'; mode: string }
  | {
      kind: 'error'
      status: number | null
      code: string | null
      message: string
      retry_after_ms: number | null
      retryable: boolean
      server_raw: string | null
    }
  | { kind: 'eof' }

export type RustResponsesErrorEvent = Extract<RustResponsesEvent, { kind: 'error' }>

function optStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function optNum(v: unknown): number | null {
  return num(v) ?? null
}

/** A channel payload of `responses_stream`, checked. Unknown kinds are null. */
export function parseRustResponsesEvent(raw: unknown): RustResponsesEvent | null {
  if (!isObj(raw)) return null
  switch (raw.kind) {
    case 'created':
      return { kind: 'created', response_id: optStr(raw.response_id), model: optStr(raw.model), transport: str(raw.transport) ?? '' }
    case 'text_delta':
      return { kind: 'text_delta', delta: str(raw.delta) ?? '', item_id: optStr(raw.item_id) }
    case 'reasoning_delta':
      return { kind: 'reasoning_delta', delta: str(raw.delta) ?? '', item_id: optStr(raw.item_id), summary: raw.summary === true }
    case 'function_call_started':
      return { kind: 'function_call_started', item_id: optStr(raw.item_id), call_id: str(raw.call_id) ?? '', name: str(raw.name) ?? '' }
    case 'function_call_args_delta':
      return { kind: 'function_call_args_delta', item_id: optStr(raw.item_id), call_id: optStr(raw.call_id), delta: str(raw.delta) ?? '' }
    case 'function_call_done':
      return {
        kind: 'function_call_done',
        item_id: optStr(raw.item_id),
        call_id: str(raw.call_id) ?? '',
        name: str(raw.name) ?? '',
        arguments: str(raw.arguments) ?? '',
      }
    case 'reasoning_item_done':
      return {
        kind: 'reasoning_item_done',
        item_id: str(raw.item_id) ?? '',
        encrypted_content: optStr(raw.encrypted_content),
        summary: Array.isArray(raw.summary) ? raw.summary.filter((s): s is string => typeof s === 'string') : [],
      }
    case 'completed':
      return {
        kind: 'completed',
        response_id: optStr(raw.response_id),
        model: optStr(raw.model),
        status: str(raw.status) ?? 'completed',
        finish_reason: optStr(raw.finish_reason),
        input_tokens: optNum(raw.input_tokens),
        output_tokens: optNum(raw.output_tokens),
        cached_tokens: optNum(raw.cached_tokens),
        transport: str(raw.transport) ?? '',
      }
    case 'billing':
      return { kind: 'billing', mode: str(raw.mode) ?? '' }
    case 'error':
      return {
        kind: 'error',
        status: optNum(raw.status),
        code: optStr(raw.code),
        message: str(raw.message) ?? '',
        retry_after_ms: optNum(raw.retry_after_ms),
        retryable: raw.retryable === true,
        server_raw: optStr(raw.server_raw),
      }
    case 'eof':
      return { kind: 'eof' }
    default:
      return null
  }
}

// ── Raw Responses events (SSE, WebSocket frames, JSON) ──────────────────────

export type ResponsesOutputItem =
  | { type: 'message'; id?: string; text: string }
  | { type: 'function_call'; id?: string; callId?: string; name?: string; arguments?: string; completed: boolean }
  | { type: 'reasoning'; id?: string; summary: string[]; content: string[]; encryptedContent?: string }
  | { type: 'other'; id?: string }

export interface ResponsesJsonResponse {
  id?: string
  model?: string
  status: string
  output: ResponsesOutputItem[]
  outputText?: string
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  incompleteReason?: string
  error?: { code?: string; message: string }
}

export type ResponsesWireEvent =
  | { type: 'created'; responseId?: string; model?: string }
  | { type: 'text_delta'; itemId?: string; delta: string }
  | { type: 'text_done'; itemId?: string; text: string }
  | { type: 'reasoning_delta'; itemId?: string; delta: string; summary: boolean }
  | { type: 'reasoning_done'; itemId?: string; text: string; summary: boolean }
  | { type: 'reasoning_part_added'; itemId?: string; summaryIndex: number }
  | { type: 'item_added'; outputIndex?: number; item: ResponsesOutputItem }
  | { type: 'item_done'; outputIndex?: number; item: ResponsesOutputItem }
  | { type: 'args_delta'; itemId?: string; outputIndex?: number; delta: string }
  | { type: 'args_done'; itemId?: string; outputIndex?: number; callId?: string; name?: string; arguments?: string }
  | { type: 'terminal'; kind: 'completed' | 'incomplete' | 'done' | 'failed'; response: ResponsesJsonResponse }
  | { type: 'error'; status?: number; code?: string; message: string; retryAfterMs?: number }
  | { type: 'ignored' }

function texts(v: unknown): string[] {
  return objs(v)
    .map((p) => str(p.text) ?? str(p.refusal) ?? '')
    .filter((t) => t !== '')
}

function parseItem(raw: unknown): ResponsesOutputItem {
  if (!isObj(raw)) return { type: 'other' }
  const id = nonEmpty(raw.id)
  switch (raw.type) {
    case 'message':
      return { type: 'message', id, text: texts(raw.content).join('') }
    case 'function_call':
      return {
        type: 'function_call',
        id,
        callId: nonEmpty(raw.call_id),
        name: nonEmpty(raw.name),
        arguments: str(raw.arguments),
        completed: raw.status === 'completed',
      }
    case 'reasoning':
      return {
        type: 'reasoning',
        id,
        summary: texts(raw.summary),
        content: texts(raw.content),
        encryptedContent: nonEmpty(raw.encrypted_content),
      }
    default:
      return { type: 'other', id }
  }
}

function codeOf(e: Record<string, unknown>): string | undefined {
  if (typeof e.code === 'string' && e.code) return e.code
  if (typeof e.code === 'number') return String(e.code)
  const t = str(e.type)
  return t && t !== 'error' ? t : undefined
}

/** "Please try again in 1.5s" / "in 20ms", as OpenAI words its rate limits. */
export function retryAfterFromMessage(message: string): number | undefined {
  const m = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(message)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  return /^m/i.test(m[2]) ? Math.ceil(n) : Math.ceil(n * 1000)
}

/** A whole response object (`object: "response"`), checked. */
export function parseResponsesJsonResponse(raw: unknown): ResponsesJsonResponse | null {
  if (!isObj(raw)) return null
  if (raw.object !== 'response' && !Array.isArray(raw.output)) return null
  const usage = isObj(raw.usage) ? raw.usage : undefined
  const details = usage && isObj(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const incomplete = isObj(raw.incomplete_details) ? raw.incomplete_details : undefined
  const error = isObj(raw.error) ? raw.error : undefined
  const out: ResponsesJsonResponse = {
    id: nonEmpty(raw.id),
    model: nonEmpty(raw.model),
    status: str(raw.status) || 'completed',
    output: Array.isArray(raw.output) ? raw.output.map(parseItem) : [],
  }
  if (typeof raw.output_text === 'string') out.outputText = raw.output_text
  if (usage) {
    out.usage = {
      inputTokens: num(usage.input_tokens) ?? num(usage.prompt_tokens),
      outputTokens: num(usage.output_tokens) ?? num(usage.completion_tokens),
      cachedTokens: details ? num(details.cached_tokens) : undefined,
    }
  }
  const reason = incomplete ? str(incomplete.reason) : undefined
  if (reason) out.incompleteReason = reason
  if (error) out.error = { code: codeOf(error), message: str(error.message) || 'The model server reported that the response failed.' }
  return out
}

/**
 * One raw Responses event (an SSE `data:` payload or a WebSocket text frame),
 * checked and normalised. `sseEvent` is the SSE `event:` name, used when the
 * JSON carries no `type`.
 */
export function parseResponsesWireEvent(raw: unknown, sseEvent?: string): ResponsesWireEvent {
  if (!isObj(raw)) return { type: 'ignored' }
  const type = str(raw.type) ?? sseEvent ?? ''
  const itemId = nonEmpty(raw.item_id)
  const outputIndex = num(raw.output_index)
  if (!type && raw.object === 'response') {
    const response = parseResponsesJsonResponse(raw)
    if (!response) return { type: 'ignored' }
    const kind = response.status === 'failed' ? 'failed' : response.status === 'incomplete' ? 'incomplete' : 'completed'
    return { type: 'terminal', kind, response }
  }
  switch (type) {
    case 'response.created':
    case 'response.in_progress':
    case 'response.queued': {
      const r = isObj(raw.response) ? raw.response : {}
      return { type: 'created', responseId: nonEmpty(r.id), model: nonEmpty(r.model) }
    }
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return { type: 'text_delta', itemId, delta: str(raw.delta) ?? '' }
    case 'response.content_part.added': {
      const part = isObj(raw.part) ? raw.part : {}
      return { type: 'text_delta', itemId, delta: str(part.text) ?? '' }
    }
    case 'response.output_text.done':
    case 'response.refusal.done':
      return { type: 'text_done', itemId, text: str(raw.text) ?? str(raw.refusal) ?? '' }
    case 'response.content_part.done': {
      const part = isObj(raw.part) ? raw.part : {}
      return { type: 'text_done', itemId, text: str(part.text) ?? str(part.refusal) ?? '' }
    }
    case 'response.reasoning_summary_part.added':
      return { type: 'reasoning_part_added', itemId, summaryIndex: num(raw.summary_index) ?? 0 }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
    case 'response.reasoning.delta':
      return { type: 'reasoning_delta', itemId, delta: str(raw.delta) ?? '', summary: type.includes('summary') }
    case 'response.reasoning_summary_text.done':
    case 'response.reasoning_text.done':
      return { type: 'reasoning_done', itemId, text: str(raw.text) ?? '', summary: type.includes('summary') }
    case 'response.output_item.added':
      return { type: 'item_added', outputIndex, item: parseItem(raw.item) }
    case 'response.output_item.done':
      return { type: 'item_done', outputIndex, item: parseItem(raw.item) }
    case 'response.function_call_arguments.delta':
      return { type: 'args_delta', itemId, outputIndex, delta: str(raw.delta) ?? '' }
    case 'response.function_call_arguments.done':
      return {
        type: 'args_done',
        itemId,
        outputIndex,
        callId: nonEmpty(raw.call_id),
        name: nonEmpty(raw.name),
        arguments: str(raw.arguments),
      }
    case 'response.completed':
    case 'response.incomplete':
    case 'response.done':
    case 'response.failed': {
      const response = parseResponsesJsonResponse(isObj(raw.response) ? { object: 'response', ...raw.response } : raw)
      if (!response) return { type: 'ignored' }
      const kind = type === 'response.failed' || response.status === 'failed'
        ? 'failed'
        : type === 'response.incomplete' ? 'incomplete' : type === 'response.done' ? 'done' : 'completed'
      return { type: 'terminal', kind, response }
    }
    case 'error': {
      // The WebSocket wraps it: {"type":"error","status":429,"error":{…}}.
      const e = isObj(raw.error) ? raw.error : raw
      const message = str(e.message) || str(raw.message) || 'The model server reported an error.'
      return {
        type: 'error',
        status: num(raw.status) ?? num(raw.status_code),
        code: codeOf(e),
        message,
        retryAfterMs: retryAfterFromMessage(message),
      }
    }
    default:
      return { type: 'ignored' }
  }
}

/** A non-2xx HTTP answer of a Responses endpoint as an error event. */
export function parseResponsesErrorBody(status: number, body: string, retryAfterMs?: number): RustResponsesErrorEvent {
  let message = ''
  let code: string | null = null
  try {
    const parsed: unknown = JSON.parse(body)
    if (isObj(parsed)) {
      const e = parsed.error
      if (typeof e === 'string') message = e
      else if (isObj(e)) {
        message = str(e.message) ?? ''
        code = codeOf(e) ?? null
      } else if (typeof parsed.message === 'string') message = parsed.message
      if (!code && typeof parsed.code === 'string' && parsed.code) code = parsed.code
    }
  } catch { /* not JSON: the text itself below */ }
  const trimmed = body.trim()
  if (!message) message = trimmed ? `HTTP ${status}: ${trimmed.slice(0, 300)}` : `HTTP ${status}`
  return {
    kind: 'error',
    status,
    code,
    message,
    retry_after_ms: retryAfterMs ?? retryAfterFromMessage(message) ?? null,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    server_raw: trimmed ? trimmed.slice(0, 4096) : null,
  }
}

// ── The accumulator (twin of the Rust one) ──────────────────────────────────

interface CallState {
  itemId?: string
  callId?: string
  name?: string
  outputIndex?: number
  args: string
  started: boolean
  done: boolean
}

/**
 * Raw Responses events in, `RustResponsesEvent`s out, for one turn. Handles
 * the servers that send a text only in `.done` (no deltas), only the final
 * response object, or name their items only sometimes, without emitting any
 * text or tool call twice.
 */
export class ResponsesWireAccumulator {
  private readonly transport: string
  private createdSent = false
  private responseId: string | null = null
  private model: string | null = null
  private readonly textSeen = new Set<string>()
  private readonly reasoningSeen = new Set<string>()
  private readonly reasoningDone = new Set<string>()
  private readonly calls: CallState[] = []
  private synthetic = 0
  /** Text, reasoning or a tool call was emitted. */
  visible = false
  terminal: 'completed' | 'failed' | null = null

  constructor(transport: string) {
    this.transport = transport
  }

  process(raw: unknown, sseEvent?: string): RustResponsesEvent[] {
    const out: RustResponsesEvent[] = []
    if (this.terminal) return out
    const ev = parseResponsesWireEvent(raw, sseEvent)
    switch (ev.type) {
      case 'created':
        if (ev.responseId) this.responseId = ev.responseId
        if (ev.model) this.model = ev.model
        if (!this.createdSent) {
          this.createdSent = true
          out.push({ kind: 'created', response_id: this.responseId, model: this.model, transport: this.transport })
        }
        break
      case 'text_delta':
        this.text(ev.itemId, ev.delta, out)
        break
      case 'text_done':
        this.textTail(ev.itemId, ev.text, out)
        break
      case 'reasoning_part_added':
        if (ev.summaryIndex > 0 && this.reasoningSeen.has(ev.itemId ?? '')) {
          out.push({ kind: 'reasoning_delta', delta: '\n\n', item_id: ev.itemId ?? null, summary: true })
        }
        break
      case 'reasoning_delta':
        this.reasoning(ev.itemId, ev.delta, ev.summary, out)
        break
      case 'reasoning_done':
        if (!this.reasoningAlready(ev.itemId ?? '')) this.reasoning(ev.itemId, ev.text, ev.summary, out)
        break
      case 'item_added':
        if (ev.item.type === 'function_call') {
          const c = this.callFor(ev.item.id, ev.outputIndex, ev.item.callId)
          if (ev.item.callId) c.callId = ev.item.callId
          if (ev.item.name) c.name = ev.item.name
          if (ev.item.arguments && !c.args) c.args = ev.item.arguments
          this.start(c, out)
        }
        break
      case 'args_delta':
        if (ev.delta) {
          const c = this.callFor(ev.itemId, ev.outputIndex, undefined)
          c.args += ev.delta
          this.visible = true
          if (c.name) this.start(c, out)
          out.push({ kind: 'function_call_args_delta', item_id: c.itemId ?? ev.itemId ?? null, call_id: c.callId ?? null, delta: ev.delta })
        }
        break
      case 'args_done': {
        const c = this.callFor(ev.itemId, ev.outputIndex, ev.callId)
        if (ev.arguments !== undefined) c.args = ev.arguments
        if (ev.name) c.name = ev.name
        if (c.name && !c.done) {
          this.start(c, out)
          this.finishCall(c, out)
        }
        break
      }
      case 'item_done':
        this.itemDone(ev.item, ev.outputIndex, out)
        break
      case 'terminal':
        this.finish(ev.kind, ev.response, out)
        break
      case 'error':
        this.terminal = 'failed'
        out.push({
          kind: 'error',
          status: ev.status ?? null,
          code: ev.code ?? null,
          message: ev.message,
          retry_after_ms: ev.retryAfterMs ?? null,
          retryable: ev.status === 429 || (ev.status ?? 0) >= 500,
          server_raw: null,
        })
        break
      case 'ignored':
        break
    }
    return out
  }

  /** `[DONE]` without a terminal event: close an answer that produced output. */
  finishWithoutTerminal(): RustResponsesEvent[] {
    const out: RustResponsesEvent[] = []
    if (this.terminal || (!this.visible && this.calls.length === 0)) return out
    this.flushCalls(out)
    out.push({
      kind: 'completed',
      response_id: this.responseId,
      model: this.model,
      status: 'completed',
      finish_reason: this.calls.length > 0 ? 'tool_calls' : 'stop',
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      transport: this.transport,
    })
    this.terminal = 'completed'
    return out
  }

  private text(itemId: string | undefined, delta: string, out: RustResponsesEvent[]): void {
    if (!delta) return
    this.textSeen.add(itemId ?? '')
    this.visible = true
    out.push({ kind: 'text_delta', delta, item_id: itemId ?? null })
  }

  private textTail(itemId: string | undefined, text: string, out: RustResponsesEvent[]): void {
    const key = itemId ?? ''
    if (this.textSeen.has(key) || this.textSeen.has('') || (key === '' && this.textSeen.size > 0)) return
    this.text(itemId, text, out)
  }

  private reasoningAlready(key: string): boolean {
    return this.reasoningSeen.has(key) || this.reasoningSeen.has('') || (key === '' && this.reasoningSeen.size > 0)
  }

  private reasoning(itemId: string | undefined, delta: string, summary: boolean, out: RustResponsesEvent[]): void {
    if (!delta) return
    this.reasoningSeen.add(itemId ?? '')
    this.visible = true
    out.push({ kind: 'reasoning_delta', delta, item_id: itemId ?? null, summary })
  }

  private callFor(itemId: string | undefined, outputIndex: number | undefined, callId: string | undefined): CallState {
    let c = itemId ? this.calls.find((x) => x.itemId === itemId) : undefined
    if (!c && callId) c = this.calls.find((x) => x.callId === callId)
    if (!c && outputIndex !== undefined) c = this.calls.find((x) => x.outputIndex === outputIndex)
    if (!c && !itemId && !callId && outputIndex === undefined) {
      for (let i = this.calls.length - 1; i >= 0; i--) {
        if (!this.calls[i].done) {
          c = this.calls[i]
          break
        }
      }
    }
    if (c) {
      if (!c.itemId && itemId) c.itemId = itemId
      if (!c.callId && callId) c.callId = callId
      if (c.outputIndex === undefined && outputIndex !== undefined) c.outputIndex = outputIndex
      return c
    }
    const fresh: CallState = { itemId, callId, outputIndex, args: '', started: false, done: false }
    this.calls.push(fresh)
    return fresh
  }

  private callIdOf(c: CallState): string {
    if (!c.callId) c.callId = c.itemId ?? `call_${++this.synthetic}`
    return c.callId
  }

  private start(c: CallState, out: RustResponsesEvent[]): void {
    if (c.started) return
    c.started = true
    this.visible = true
    out.push({ kind: 'function_call_started', item_id: c.itemId ?? null, call_id: this.callIdOf(c), name: c.name ?? '' })
  }

  private finishCall(c: CallState, out: RustResponsesEvent[]): void {
    if (c.done) return
    c.done = true
    this.visible = true
    out.push({ kind: 'function_call_done', item_id: c.itemId ?? null, call_id: this.callIdOf(c), name: c.name ?? '', arguments: c.args })
  }

  private flushCalls(out: RustResponsesEvent[]): void {
    for (const c of this.calls) {
      if (c.done) continue
      this.start(c, out)
      this.finishCall(c, out)
    }
  }

  private itemDone(item: ResponsesOutputItem, outputIndex: number | undefined, out: RustResponsesEvent[]): void {
    switch (item.type) {
      case 'function_call': {
        const c = this.callFor(item.id, outputIndex, item.callId)
        if (c.done) return
        if (item.callId) c.callId = item.callId
        if (item.name) c.name = item.name
        if (item.arguments) c.args = item.arguments
        this.start(c, out)
        this.finishCall(c, out)
        return
      }
      case 'reasoning': {
        const id = item.id ?? `rs_${++this.synthetic}`
        if (this.reasoningDone.has(id)) return
        this.reasoningDone.add(id)
        if (!this.reasoningAlready(id)) {
          if (item.summary.length > 0) this.reasoning(id, item.summary.join('\n\n'), true, out)
          else this.reasoning(id, item.content.join(''), false, out)
        }
        out.push({ kind: 'reasoning_item_done', item_id: id, encrypted_content: item.encryptedContent ?? null, summary: item.summary })
        return
      }
      case 'message':
        this.textTail(item.id, item.text, out)
        return
      case 'other':
        return
    }
  }

  private finish(kind: 'completed' | 'incomplete' | 'done' | 'failed', r: ResponsesJsonResponse, out: RustResponsesEvent[]): void {
    if (r.id) this.responseId = r.id
    if (r.model) this.model = r.model
    if (kind === 'failed') {
      this.terminal = 'failed'
      const message = r.error?.message ?? 'The model server reported that the response failed.'
      out.push({
        kind: 'error',
        status: null,
        code: r.error?.code ?? null,
        message,
        retry_after_ms: retryAfterFromMessage(message) ?? null,
        retryable: r.error?.code === 'server_error' || r.error?.code === 'rate_limit_exceeded',
        server_raw: null,
      })
      return
    }
    r.output.forEach((item, index) => this.itemDone(item, index, out))
    this.flushCalls(out)
    const incomplete = kind === 'incomplete' || r.status === 'incomplete'
    const finish = incomplete && r.incompleteReason === 'content_filter'
      ? 'content_filter'
      : incomplete ? 'length' : this.calls.length > 0 ? 'tool_calls' : 'stop'
    out.push({
      kind: 'completed',
      response_id: this.responseId,
      model: this.model,
      status: incomplete ? 'incomplete' : r.status || 'completed',
      finish_reason: finish,
      input_tokens: r.usage?.inputTokens ?? null,
      output_tokens: r.usage?.outputTokens ?? null,
      cached_tokens: r.usage?.cachedTokens ?? null,
      transport: this.transport,
    })
    this.terminal = 'completed'
  }
}
