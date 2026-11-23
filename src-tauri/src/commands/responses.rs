//! Native OpenAI Responses API transport: `POST …/v1/responses` over HTTP SSE
//! and the persistent `wss://…/v1/responses` WebSocket, behind one Tauri
//! command (`responses_stream`) and one event vocabulary
//! (`ResponsesStreamEvent`).
//!
//! Why a Rust transport and not a `fetch` in the web view:
//!
//!   * The web view cannot open a `wss://` socket to a provider the pinned CSP
//!     does not list, and it cannot reach a LAN backend that sends no CORS
//!     headers. Both are the reasons `proxy_localhost_stream_chunked` exists;
//!     the Responses API has the same two problems and one more: the socket
//!     should outlive a single turn so the server can keep its context warm.
//!   * Stop has to stop the backend. Dropping the socket or the HTTP stream in
//!     Rust closes the TCP connection, which is what makes a server stop
//!     generating; a cancelled JS reader does not.
//!
//! The shape of one turn:
//!
//!   1. `prepare` checks the URL against the same allow-list as every other
//!      proxy command (`ProxyAllowList::check_responses_url`, ws/wss held to
//!      the rules of their http/https twins), refuses a built-in engine
//!      request for the wrong model, swaps in the engine key, and derives the
//!      HTTP and WebSocket endpoints.
//!   2. `run_turn` picks the transport. `auto` tries the WebSocket first and
//!      falls back to SSE on exactly two triggers: the server refused the
//!      upgrade (400/404/405/426/501 or no upgrade at all), or the bounded
//!      retries of a transport failure ran out. Never after anything visible
//!      reached the user: a restart would show the start of the answer twice.
//!   3. One `ResponsesEventAccumulator` turns every Responses event, from
//!      either transport, into the same `ResponsesStreamEvent`s, including the
//!      servers that send a whole text in `.done` without deltas, or only the
//!      final response object.
//!   4. On the WebSocket, a clean `response.completed` (and nothing else)
//!      commits the turn as the base of the next one: the next request then
//!      carries `previous_response_id` and only the new input items.
//!
//! The event channel always ends with `Eof`, after every early return, for the
//! same WebView2 ordering reason as `pump_proxy_stream`: queued channel
//! messages can arrive after the invoke result, so the renderer closes on the
//! marker, not on the result.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::proxy::{redact_url, ProxyAllowList, FIRST_CHUNK_OFF};
use crate::os_error;

/// The beta header the OpenAI Responses WebSocket requires on the upgrade.
pub const OPENAI_BETA_WS: &str = "responses_websockets=2026-02-06";

/// Silence allowed between two events once the answer is running. Same value
/// and same reasoning as `proxy_localhost_stream_chunked`'s IDLE_TIMEOUT_MS: a
/// backend that died with its socket open must not hold the UI for the two
/// hours of the whole-request limit.
const DEFAULT_IDLE: Duration = Duration::from_secs(60);

/// The wait for the first visible output when the renderer sent no Chat Reply
/// Timeout. Same as FIRST_CHUNK_GRACE in proxy.rs: a cold model is read off
/// disk in this window, and a reasoning model thinks in it.
const DEFAULT_FIRST_CHUNK: Duration = Duration::from_secs(600);

/// Ping interval on a WebSocket turn. Keeps NAT tables and proxies from
/// dropping a socket that is silent because the model is reasoning.
const WS_PING_EVERY: Duration = Duration::from_secs(15);

/// Upper bound for the WebSocket handshake and for one frame write.
const WS_CONNECT_LIMIT: Duration = Duration::from_secs(30);

/// Attempts on the WebSocket for a retryable failure before any output (the
/// second trigger of the SSE fallback is "these ran out").
const WS_MAX_ATTEMPTS: usize = 2;

/// Cached sessions (one socket each). Oldest first out.
const MAX_SESSIONS: usize = 64;

/// Endpoints remembered as "no WebSocket here". Oldest first out.
const MAX_WS_UNSUPPORTED: usize = 256;

/// Upgrade answers that mean "this server does not speak the Responses
/// WebSocket" rather than "this request is wrong": fall back to SSE.
const FALLBACK_STATUSES: [u16; 5] = [400, 404, 405, 426, 501];

/// Most of a server's raw error body that travels to the renderer.
const SERVER_RAW_MAX: usize = 4096;

/// The `code` of a first-reply watchdog failure. Same string as the
/// renderer's FIRST_REPLY_TIMEOUT, so one mapping covers both transports.
const FIRST_REPLY_TIMEOUT: &str = "first_reply_timeout";

// ---------------------------------------------------------------------------
// Wire types (Tauri IPC)
// ---------------------------------------------------------------------------

/// One `responses_stream` call, as the renderer sends it (camelCase in JS).
///
/// No `Debug`: `headers` carries the provider key, and a derived `Debug` is
/// one `tracing::debug!(?req)` away from writing it into a log file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsesStreamRequest {
    /// The provider's base URL (`https://api.openai.com/v1`) or the full
    /// `…/responses` endpoint. http(s) or ws(s).
    pub url: String,
    /// "auto" (default), "websocket" or "sse".
    #[serde(default)]
    pub transport: Option<String>,
    /// The serialized `/v1/responses` request body.
    pub body_json: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Id for `responses_cancel`. Minted here when missing.
    #[serde(default)]
    pub stream_id: Option<String>,
    /// Chat-scoped id. Same id, same endpoint and same key reuse one socket
    /// and its `previous_response_id` chain.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Max silence between events once output started. 0 = Off.
    #[serde(default)]
    pub idle_timeout_ms: Option<u64>,
    /// Max wait for the first output. 0 = Off. Chat Reply Timeout.
    #[serde(default)]
    pub first_chunk_timeout_ms: Option<u64>,
}

/// What the renderer receives, in order. Tagged with `kind`, snake_case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResponsesStreamEvent {
    Created {
        response_id: Option<String>,
        model: Option<String>,
        transport: String,
    },
    TextDelta {
        delta: String,
        item_id: Option<String>,
    },
    ReasoningDelta {
        delta: String,
        item_id: Option<String>,
        summary: bool,
    },
    FunctionCallStarted {
        item_id: Option<String>,
        call_id: String,
        name: String,
    },
    FunctionCallArgsDelta {
        item_id: Option<String>,
        call_id: Option<String>,
        delta: String,
    },
    FunctionCallDone {
        item_id: Option<String>,
        call_id: String,
        name: String,
        arguments: String,
    },
    ReasoningItemDone {
        item_id: String,
        encrypted_content: Option<String>,
        summary: Vec<String>,
    },
    Completed {
        response_id: Option<String>,
        model: Option<String>,
        status: String,
        finish_reason: Option<String>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cached_tokens: Option<u64>,
        transport: String,
    },
    /// `x-lu-chat-billing` of LU Cloud: "flash" or "credits".
    Billing { mode: String },
    Error {
        status: Option<u16>,
        code: Option<String>,
        message: String,
        retry_after_ms: Option<u64>,
        retryable: bool,
        server_raw: Option<String>,
    },
    Eof {},
}

// ---------------------------------------------------------------------------
// Transport choice, failures, turn results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transport {
    Auto,
    WebSocket,
    Sse,
}

impl Transport {
    pub(crate) fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("auto") => Ok(Self::Auto),
            Some("websocket") | Some("ws") | Some("wss") => Ok(Self::WebSocket),
            Some("sse") | Some("http") => Ok(Self::Sse),
            Some(other) => Err(format!(
                "Unknown Responses transport '{other}'. Use auto, websocket or sse."
            )),
        }
    }
}

/// A failed turn, in the shape the renderer maps to a chat message.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResponsesFailure {
    pub(crate) status: Option<u16>,
    pub(crate) code: Option<String>,
    pub(crate) message: String,
    pub(crate) retry_after_ms: Option<u64>,
    pub(crate) retryable: bool,
    pub(crate) server_raw: Option<String>,
}

impl ResponsesFailure {
    pub(crate) fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            status: None,
            code: Some(code.to_string()),
            message: message.into(),
            retry_after_ms: None,
            retryable,
            server_raw: None,
        }
    }

    /// The event the renderer gets. Both texts go through `redact_secrets`
    /// on the way out: a server that echoes the key it was sent ("Incorrect
    /// API key provided: sk-…") must not put it in a chat bubble.
    pub(crate) fn into_event(self) -> ResponsesStreamEvent {
        ResponsesStreamEvent::Error {
            status: self.status,
            code: self.code,
            message: redact_secrets(&self.message),
            retry_after_ms: self.retry_after_ms,
            retryable: self.retryable,
            server_raw: self.server_raw.map(|raw| redact_secrets(&raw)),
        }
    }
}

/// How a failed attempt may be handled by the layer above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailKind {
    /// The server does not speak the WebSocket: fall back to SSE (auto).
    Unsupported,
    /// Transport trouble before output: retry, then fall back (auto).
    Retryable,
    /// The server refused `previous_response_id`: retry once without it.
    ChainRejected,
    /// Surface as it is.
    Final,
}

#[derive(Debug, Clone)]
pub(crate) struct TurnFailure {
    pub(crate) failure: ResponsesFailure,
    /// Something visible (text, reasoning, a tool call) already reached the
    /// renderer. Nothing may restart the turn then.
    pub(crate) visible: bool,
    pub(crate) kind: FailKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    /// `commit` is the response id a WebSocket chain may continue from.
    Completed { commit: Option<String> },
    Cancelled,
    /// The renderer's channel is gone (window closed, reader dropped).
    SinkGone,
}

/// Where events go. `false` means the receiver is gone and the turn stops.
pub(crate) type Sink<'a> = &'a (dyn Fn(ResponsesStreamEvent) -> bool + Send + Sync);

/// Everything one turn needs, independent of Tauri so the tests can drive it.
///
/// No `Debug`: `headers` carries the provider key.
pub(crate) struct TurnSpec {
    pub(crate) http_url: String,
    pub(crate) ws_url: String,
    /// The WebSocket endpoint without query and userinfo: key of the session
    /// cache and of the "no WebSocket here" memory.
    pub(crate) endpoint_key: String,
    pub(crate) body: Map<String, Value>,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) auth_fingerprint: String,
    pub(crate) session_id: Option<String>,
    pub(crate) first_window: Duration,
    pub(crate) idle: Duration,
}

// ---------------------------------------------------------------------------
// URLs, headers, redaction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResponsesEndpoints {
    pub(crate) http: String,
    pub(crate) ws: String,
}

/// The HTTP and the WebSocket endpoint for a provider URL.
///
/// `/responses` is appended unless the path already ends with it, so the
/// base URL of the provider settings (`https://api.openai.com/v1`) and a
/// pasted full endpoint both work. A query (Azure's `api-version`) stays.
pub(crate) fn responses_endpoints(raw: &str) -> Result<ResponsesEndpoints, String> {
    let mut url =
        url::Url::parse(raw.trim()).map_err(|e| format!("Invalid Responses URL: {e}"))?;
    let (http_scheme, ws_scheme) = match url.scheme() {
        "http" | "ws" => ("http", "ws"),
        "https" | "wss" => ("https", "wss"),
        other => return Err(format!("Blocked scheme: {other}")),
    };
    if url.host_str().unwrap_or("").is_empty() {
        return Err("Invalid Responses URL: it names no host.".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    let path = if path.ends_with("/responses") {
        path
    } else {
        format!("{path}/responses")
    };
    url.set_path(&path);
    url.set_fragment(None);
    let mut http = url.clone();
    http.set_scheme(http_scheme)
        .map_err(|_| "Invalid Responses URL.".to_string())?;
    let mut ws = url;
    ws.set_scheme(ws_scheme)
        .map_err(|_| "Invalid Responses URL.".to_string())?;
    Ok(ResponsesEndpoints {
        http: http.to_string(),
        ws: ws.to_string(),
    })
}

/// Headers the transport derives itself or that would break the upgrade.
const DROPPED_HEADERS: [&str; 10] = [
    "host",
    "content-length",
    "connection",
    "upgrade",
    "transfer-encoding",
    "keep-alive",
    "te",
    "trailer",
    "proxy-connection",
    "proxy-authorization",
];

/// The caller's headers as they go on the wire: hop-by-hop and
/// `sec-websocket-*` dropped, the LU Engine key in place of whatever the web
/// view sent for the engine (`with_engine_key`), and the engine token when
/// the request goes to this process's engine. Sorted, so the session key and
/// the tests see a stable order.
pub(crate) fn outgoing_headers(
    http_url: &str,
    caller: Option<HashMap<String, String>>,
    engine_ports: &[u16],
) -> Vec<(String, String)> {
    let filtered: HashMap<String, String> = caller
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| {
            let l = k.trim().to_ascii_lowercase();
            !l.is_empty()
                && !DROPPED_HEADERS.contains(&l.as_str())
                && !l.starts_with("sec-websocket-")
                && l != super::engine_token::HEADER
        })
        .collect();
    let mut out: Vec<(String, String)> =
        super::proxy::with_engine_key(http_url, Some(filtered), engine_ports)
            .unwrap_or_default()
            .into_iter()
            .collect();
    if let Some(token) = super::engine_token::token_for_url(http_url) {
        out.push((super::engine_token::HEADER.to_string(), token.to_string()));
    }
    out.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));
    out
}

/// A short, one-way fingerprint of the credentials, so two keys against the
/// same endpoint never share a socket (and so the key itself is not the map
/// key in memory).
pub(crate) fn auth_fingerprint(headers: &[(String, String)]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut any = false;
    for (k, v) in headers {
        let l = k.to_ascii_lowercase();
        if matches!(
            l.as_str(),
            "authorization" | "x-api-key" | "api-key" | "openai-organization" | "openai-project"
        ) {
            hasher.update(l.as_bytes());
            hasher.update(b"=");
            hasher.update(v.as_bytes());
            hasher.update(b"\n");
            any = true;
        }
    }
    if !any {
        return "anon".to_string();
    }
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Second pass of the secret scrubber (the first is `redact_url` on every URL
/// that goes into a message): bearer tokens, auth header values, key-shaped
/// query parameters and the known key formats, wherever they sit in a text.
pub(crate) fn redact_secrets(text: &str) -> String {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (
                r#"(?i)\b(authorization\s*["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;&]+"#,
                "${1}[REDACTED]",
            ),
            (
                r#"(?i)\b((?:x-api-key|api-key|openai-api-key|x-goog-api-key)\s*["']?\s*[:=]\s*["']?)[^\s"',;&]+"#,
                "${1}[REDACTED]",
            ),
            (r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{4,}", "${1}[REDACTED]"),
            (
                r#"(?i)([?&](?:api[_-]?key|key|token|access[_-]?token|secret|password|sig|signature)=)[^&\s#"']+"#,
                "${1}[REDACTED]",
            ),
            (r"\b(?:sk|pk|rk|gsk|xai)[-_][A-Za-z0-9_-]{12,}", "[REDACTED]"),
            (r"\blu_[A-Za-z0-9]{16,}", "[REDACTED]"),
            (r"\bhf_[A-Za-z0-9]{20,}", "[REDACTED]"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| {
            (
                regex::Regex::new(pattern).expect("static redaction pattern"),
                replacement,
            )
        })
        .collect()
    });
    let mut out = text.to_string();
    for (re, replacement) in patterns {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SseFrame {
    pub(crate) event: Option<String>,
    pub(crate) data: String,
}

/// Byte chunks in, SSE frames out.
///
/// A chunk boundary can fall inside a multibyte character ("ą" is two bytes,
/// an emoji four): the incomplete tail is carried to the next chunk instead
/// of being decoded lossily, which would put U+FFFD into the middle of a
/// Polish word. `\r\n`, `\n` and a lone `\r` all end a line, also when the
/// `\r\n` pair is split across two chunks. `:` comment lines (keep-alives)
/// are skipped, several `data:` lines join with `\n`.
#[derive(Default)]
pub(crate) struct SseLineDecoder {
    carry: Vec<u8>,
    line: String,
    pending_cr: bool,
    event: Option<String>,
    data: Vec<String>,
}

impl SseLineDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<SseFrame> {
        let text = self.decode(bytes);
        let mut out = Vec::new();
        for ch in text.chars() {
            if self.pending_cr {
                self.pending_cr = false;
                if ch == '\n' {
                    continue;
                }
            }
            match ch {
                '\r' => {
                    self.pending_cr = true;
                    self.end_line(&mut out);
                }
                '\n' => self.end_line(&mut out),
                c => self.line.push(c),
            }
        }
        out
    }

    /// End of stream: whatever is left forms the last frame.
    pub(crate) fn finish(&mut self) -> Vec<SseFrame> {
        let mut out = Vec::new();
        if !self.carry.is_empty() {
            self.carry.clear();
            self.line.push('\u{FFFD}');
        }
        if !self.line.is_empty() {
            self.end_line(&mut out);
        }
        self.dispatch(&mut out);
        out
    }

    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut start = 0;
        loop {
            match std::str::from_utf8(&buf[start..]) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if let Ok(s) = std::str::from_utf8(&buf[start..start + valid]) {
                        out.push_str(s);
                    }
                    match e.error_len() {
                        // A broken sequence in the middle: replace it, go on.
                        Some(n) => {
                            out.push('\u{FFFD}');
                            start += valid + n;
                        }
                        // An incomplete sequence at the end: wait for the rest.
                        None => {
                            self.carry = buf[start + valid..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    fn end_line(&mut self, out: &mut Vec<SseFrame>) {
        let line = std::mem::take(&mut self.line);
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line.as_str(), ""),
        };
        match field {
            "data" => self.data.push(value.to_string()),
            "event" => self.event = Some(value.to_string()),
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<SseFrame>) {
        if self.data.is_empty() {
            self.event = None;
            return;
        }
        let data = self.data.join("\n");
        self.data.clear();
        out.push(SseFrame {
            event: self.event.take(),
            data,
        });
    }
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn opt_string(v: &Value, key: &str) -> Option<String> {
    str_of(v, key)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn code_of(e: &Value) -> Option<String> {
    match e.get("code") {
        Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
        Some(Value::Number(n)) => return Some(n.to_string()),
        _ => {}
    }
    match str_of(e, "type") {
        Some(t) if !t.is_empty() && t != "error" => Some(t.to_string()),
        _ => None,
    }
}

fn key_of(id: Option<&str>) -> String {
    id.unwrap_or("").to_string()
}

#[derive(Debug, Clone, Default)]
struct CallState {
    item_id: Option<String>,
    call_id: Option<String>,
    name: Option<String>,
    output_index: Option<u64>,
    args: String,
    started: bool,
    done: bool,
}

#[derive(Debug, Clone)]
pub(crate) enum Terminal {
    Completed { commit: Option<String> },
    Failed(ResponsesFailure),
}

/// Every Responses event, from SSE or the WebSocket, into
/// `ResponsesStreamEvent`s. One instance per attempt.
pub(crate) struct ResponsesEventAccumulator {
    transport: &'static str,
    created_sent: bool,
    response_id: Option<String>,
    model: Option<String>,
    /// Items whose text arrived as deltas ("" = deltas without an item id).
    text_seen: HashSet<String>,
    reasoning_seen: HashSet<String>,
    reasoning_done: HashSet<String>,
    calls: Vec<CallState>,
    synthetic_ids: usize,
    /// Text, reasoning or a tool call reached the renderer.
    pub(crate) visible: bool,
    /// The first-reply phase is over; the idle window applies from here on.
    pub(crate) meaningful: bool,
    /// The assistant text of this turn, and the ids of its tool calls: what
    /// the client will echo back in the next turn's input.
    pub(crate) text_out: String,
    pub(crate) call_ids_out: Vec<String>,
    pub(crate) terminal: Option<Terminal>,
}

impl ResponsesEventAccumulator {
    pub(crate) fn new(transport: &'static str) -> Self {
        Self {
            transport,
            created_sent: false,
            response_id: None,
            model: None,
            text_seen: HashSet::new(),
            reasoning_seen: HashSet::new(),
            reasoning_done: HashSet::new(),
            calls: Vec::new(),
            synthetic_ids: 0,
            visible: false,
            meaningful: false,
            text_out: String::new(),
            call_ids_out: Vec::new(),
            terminal: None,
        }
    }

    /// One parsed frame. `sse_event` is the SSE `event:` name, used when the
    /// JSON carries no `type`.
    pub(crate) fn process(&mut self, sse_event: Option<&str>, frame: &Value) -> Vec<ResponsesStreamEvent> {
        let mut out = Vec::new();
        if self.terminal.is_some() {
            return out;
        }
        let ty = str_of(frame, "type").or(sse_event).unwrap_or("");
        // A whole response object: a non-streaming JSON answer, or a server
        // that sends only the result.
        if ty.is_empty() && str_of(frame, "object") == Some("response") {
            let ty = match str_of(frame, "status") {
                Some("failed") => "response.failed",
                Some("incomplete") => "response.incomplete",
                _ => "response.completed",
            };
            self.finish(ty, frame, &mut out);
            return out;
        }
        let item_id = opt_string(frame, "item_id");
        let output_index = frame.get("output_index").and_then(Value::as_u64);
        match ty {
            "response.created" | "response.in_progress" | "response.queued" => {
                if let Some(resp) = frame.get("response") {
                    self.capture_ids(resp);
                }
                if !self.created_sent {
                    self.created_sent = true;
                    out.push(ResponsesStreamEvent::Created {
                        response_id: self.response_id.clone(),
                        model: self.model.clone(),
                        transport: self.transport.to_string(),
                    });
                }
            }
            "response.output_item.added" => {
                if let Some(item) = frame.get("item") {
                    if str_of(item, "type") == Some("function_call") {
                        let i = self.call_for(opt_string(item, "id"), output_index, opt_string(item, "call_id"));
                        self.update_call(i, item);
                        self.start_call(i, &mut out);
                    }
                }
            }
            "response.content_part.added" => {
                if let Some(part) = frame.get("part") {
                    let text = str_of(part, "text").unwrap_or("");
                    self.emit_text(item_id, text, &mut out);
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let delta = str_of(frame, "delta").unwrap_or("");
                self.emit_text(item_id, delta, &mut out);
            }
            "response.output_text.done" | "response.refusal.done" => {
                let text = str_of(frame, "text").or(str_of(frame, "refusal")).unwrap_or("");
                self.emit_text_tail(item_id, text, &mut out);
            }
            "response.content_part.done" => {
                if let Some(part) = frame.get("part") {
                    let text = str_of(part, "text").or(str_of(part, "refusal")).unwrap_or("");
                    self.emit_text_tail(item_id, text, &mut out);
                }
            }
            "response.reasoning_summary_part.added" => {
                // A second summary part: keep the parts apart in the thinking
                // panel instead of gluing two paragraphs into one.
                let index = frame.get("summary_index").and_then(Value::as_u64).unwrap_or(0);
                if index > 0 && self.reasoning_seen.contains(&key_of(item_id.as_deref())) {
                    out.push(ResponsesStreamEvent::ReasoningDelta {
                        delta: "\n\n".to_string(),
                        item_id,
                        summary: true,
                    });
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" | "response.reasoning.delta" => {
                let delta = str_of(frame, "delta").unwrap_or("");
                let summary = ty.contains("summary");
                self.emit_reasoning(item_id, delta, summary, &mut out);
            }
            "response.reasoning_summary_text.done" | "response.reasoning_text.done" => {
                let text = str_of(frame, "text").unwrap_or("");
                let key = key_of(item_id.as_deref());
                if !self.reasoning_already(&key) {
                    self.emit_reasoning(item_id, text, ty.contains("summary"), &mut out);
                }
            }
            "response.function_call_arguments.delta" => {
                let delta = str_of(frame, "delta").unwrap_or("");
                if !delta.is_empty() {
                    let i = self.call_for(item_id.clone(), output_index, None);
                    self.calls[i].args.push_str(delta);
                    self.visible = true;
                    self.meaningful = true;
                    // Announce the call before its first argument bytes when
                    // the server named it but skipped output_item.added.
                    if self.calls[i].name.is_some() {
                        self.start_call(i, &mut out);
                    }
                    out.push(ResponsesStreamEvent::FunctionCallArgsDelta {
                        item_id: self.calls[i].item_id.clone().or(item_id),
                        call_id: self.calls[i].call_id.clone(),
                        delta: delta.to_string(),
                    });
                }
            }
            "response.function_call_arguments.done" => {
                let i = self.call_for(item_id, output_index, opt_string(frame, "call_id"));
                if let Some(args) = str_of(frame, "arguments") {
                    self.calls[i].args = args.to_string();
                }
                if let Some(name) = opt_string(frame, "name") {
                    self.calls[i].name = Some(name);
                }
                if self.calls[i].name.is_some() && !self.calls[i].done {
                    self.start_call(i, &mut out);
                    self.finish_call(i, &mut out);
                }
            }
            "response.output_item.done" => {
                if let Some(item) = frame.get("item") {
                    self.item_done(item, output_index, &mut out);
                }
            }
            "response.completed" | "response.incomplete" | "response.done" | "response.failed" => {
                let resp = frame.get("response").unwrap_or(frame);
                self.finish(ty, resp, &mut out);
            }
            "error" => {
                self.terminal = Some(Terminal::Failed(failure_from_error_frame(frame)));
            }
            _ => {}
        }
        out
    }

    /// `[DONE]` without a `response.completed` (some compat servers): an
    /// answer that produced output is closed as completed, never committed
    /// as a chain base. Returns false when there was nothing to close.
    pub(crate) fn finish_without_terminal(&mut self, out: &mut Vec<ResponsesStreamEvent>) -> bool {
        if self.terminal.is_some() || (!self.visible && self.calls.is_empty()) {
            return false;
        }
        self.flush_calls(out);
        let finish_reason = if self.calls.is_empty() { "stop" } else { "tool_calls" };
        out.push(ResponsesStreamEvent::Completed {
            response_id: self.response_id.clone(),
            model: self.model.clone(),
            status: "completed".to_string(),
            finish_reason: Some(finish_reason.to_string()),
            input_tokens: None,
            output_tokens: None,
            cached_tokens: None,
            transport: self.transport.to_string(),
        });
        self.terminal = Some(Terminal::Completed { commit: None });
        true
    }

    fn capture_ids(&mut self, resp: &Value) {
        if let Some(id) = opt_string(resp, "id") {
            self.response_id = Some(id);
        }
        if let Some(model) = opt_string(resp, "model") {
            self.model = Some(model);
        }
    }

    fn emit_text(&mut self, item_id: Option<String>, delta: &str, out: &mut Vec<ResponsesStreamEvent>) {
        if delta.is_empty() {
            return;
        }
        self.text_seen.insert(key_of(item_id.as_deref()));
        self.visible = true;
        self.meaningful = true;
        self.text_out.push_str(delta);
        out.push(ResponsesStreamEvent::TextDelta {
            delta: delta.to_string(),
            item_id,
        });
    }

    /// A `.done`-type text: only when that item got no deltas. Deltas without
    /// an item id count for every item and the other way round, so a server
    /// that names its items only sometimes does not get its text twice.
    fn emit_text_tail(&mut self, item_id: Option<String>, text: &str, out: &mut Vec<ResponsesStreamEvent>) {
        let key = key_of(item_id.as_deref());
        if self.text_seen.contains(&key)
            || self.text_seen.contains("")
            || (key.is_empty() && !self.text_seen.is_empty())
        {
            return;
        }
        self.emit_text(item_id, text, out);
    }

    fn reasoning_already(&self, key: &str) -> bool {
        self.reasoning_seen.contains(key)
            || self.reasoning_seen.contains("")
            || (key.is_empty() && !self.reasoning_seen.is_empty())
    }

    fn emit_reasoning(&mut self, item_id: Option<String>, delta: &str, summary: bool, out: &mut Vec<ResponsesStreamEvent>) {
        if delta.is_empty() {
            return;
        }
        self.reasoning_seen.insert(key_of(item_id.as_deref()));
        // Reasoning is shown in the thinking panel, so it is visible: a
        // restart after it would show the thinking twice.
        self.visible = true;
        self.meaningful = true;
        out.push(ResponsesStreamEvent::ReasoningDelta {
            delta: delta.to_string(),
            item_id,
            summary,
        });
    }

    fn find_call(&self, item_id: Option<&str>, output_index: Option<u64>, call_id: Option<&str>) -> Option<usize> {
        if let Some(id) = item_id {
            if let Some(i) = self.calls.iter().position(|c| c.item_id.as_deref() == Some(id)) {
                return Some(i);
            }
        }
        if let Some(cid) = call_id {
            if let Some(i) = self.calls.iter().position(|c| c.call_id.as_deref() == Some(cid)) {
                return Some(i);
            }
        }
        if let Some(ix) = output_index {
            if let Some(i) = self.calls.iter().position(|c| c.output_index == Some(ix)) {
                return Some(i);
            }
        }
        if item_id.is_none() && call_id.is_none() && output_index.is_none() {
            return self.calls.iter().rposition(|c| !c.done);
        }
        None
    }

    fn call_for(&mut self, item_id: Option<String>, output_index: Option<u64>, call_id: Option<String>) -> usize {
        if let Some(i) = self.find_call(item_id.as_deref(), output_index, call_id.as_deref()) {
            let c = &mut self.calls[i];
            if c.item_id.is_none() {
                c.item_id = item_id;
            }
            if c.call_id.is_none() {
                c.call_id = call_id;
            }
            if c.output_index.is_none() {
                c.output_index = output_index;
            }
            return i;
        }
        self.calls.push(CallState {
            item_id,
            call_id,
            output_index,
            ..CallState::default()
        });
        self.calls.len() - 1
    }

    fn update_call(&mut self, i: usize, item: &Value) {
        let c = &mut self.calls[i];
        if let Some(call_id) = opt_string(item, "call_id") {
            c.call_id = Some(call_id);
        }
        if let Some(name) = opt_string(item, "name") {
            c.name = Some(name);
        }
        if let Some(args) = str_of(item, "arguments") {
            // The full arguments of a finished item are authoritative; on an
            // added item they only count when no delta arrived yet.
            if !args.is_empty() && (c.args.is_empty() || str_of(item, "status") == Some("completed")) {
                c.args = args.to_string();
            }
        }
    }

    fn ensure_call_id(&mut self, i: usize) -> String {
        if let Some(id) = self.calls[i].call_id.clone() {
            return id;
        }
        let id = match self.calls[i].item_id.clone() {
            Some(item) => item,
            None => {
                self.synthetic_ids += 1;
                format!("call_{}", self.synthetic_ids)
            }
        };
        self.calls[i].call_id = Some(id.clone());
        id
    }

    fn start_call(&mut self, i: usize, out: &mut Vec<ResponsesStreamEvent>) {
        if self.calls[i].started {
            return;
        }
        let call_id = self.ensure_call_id(i);
        let c = &mut self.calls[i];
        c.started = true;
        self.visible = true;
        self.meaningful = true;
        out.push(ResponsesStreamEvent::FunctionCallStarted {
            item_id: c.item_id.clone(),
            call_id,
            name: c.name.clone().unwrap_or_default(),
        });
    }

    fn finish_call(&mut self, i: usize, out: &mut Vec<ResponsesStreamEvent>) {
        if self.calls[i].done {
            return;
        }
        let call_id = self.ensure_call_id(i);
        let c = &mut self.calls[i];
        c.done = true;
        self.visible = true;
        self.meaningful = true;
        self.call_ids_out.push(call_id.clone());
        out.push(ResponsesStreamEvent::FunctionCallDone {
            item_id: c.item_id.clone(),
            call_id,
            name: c.name.clone().unwrap_or_default(),
            arguments: c.args.clone(),
        });
    }

    fn flush_calls(&mut self, out: &mut Vec<ResponsesStreamEvent>) {
        for i in 0..self.calls.len() {
            if !self.calls[i].done {
                self.start_call(i, out);
                self.finish_call(i, out);
            }
        }
    }

    fn item_done(&mut self, item: &Value, output_index: Option<u64>, out: &mut Vec<ResponsesStreamEvent>) {
        match str_of(item, "type") {
            Some("function_call") => {
                let i = self.call_for(opt_string(item, "id"), output_index, opt_string(item, "call_id"));
                if !self.calls[i].done {
                    let c = &mut self.calls[i];
                    if let Some(call_id) = opt_string(item, "call_id") {
                        c.call_id = Some(call_id);
                    }
                    if let Some(name) = opt_string(item, "name") {
                        c.name = Some(name);
                    }
                    if let Some(args) = str_of(item, "arguments") {
                        if !args.is_empty() {
                            c.args = args.to_string();
                        }
                    }
                    self.start_call(i, out);
                    self.finish_call(i, out);
                }
            }
            Some("reasoning") => {
                let id = match opt_string(item, "id") {
                    Some(id) => id,
                    None => {
                        self.synthetic_ids += 1;
                        format!("rs_{}", self.synthetic_ids)
                    }
                };
                if self.reasoning_done.contains(&id) {
                    return;
                }
                self.reasoning_done.insert(id.clone());
                let summary: Vec<String> = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|p| str_of(p, "text"))
                            .filter(|t| !t.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if !self.reasoning_already(&id) {
                    if !summary.is_empty() {
                        self.emit_reasoning(Some(id.clone()), &summary.join("\n\n"), true, out);
                    } else {
                        // Open-weight models (gpt-oss) put raw reasoning into
                        // `content` instead of a summary.
                        let raw: Vec<&str> = item
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|parts| parts.iter().filter_map(|p| str_of(p, "text")).collect())
                            .unwrap_or_default();
                        self.emit_reasoning(Some(id.clone()), &raw.join(""), false, out);
                    }
                }
                out.push(ResponsesStreamEvent::ReasoningItemDone {
                    item_id: id,
                    encrypted_content: opt_string(item, "encrypted_content"),
                    summary,
                });
            }
            Some("message") => {
                let text: String = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|p| str_of(p, "text").or(str_of(p, "refusal")))
                            .collect()
                    })
                    .unwrap_or_default();
                self.emit_text_tail(opt_string(item, "id"), &text, out);
            }
            _ => {}
        }
    }

    fn finish(&mut self, ty: &str, resp: &Value, out: &mut Vec<ResponsesStreamEvent>) {
        self.capture_ids(resp);
        let status = str_of(resp, "status")
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                match ty {
                    "response.incomplete" => "incomplete",
                    "response.failed" => "failed",
                    _ => "completed",
                }
                .to_string()
            });
        if ty == "response.failed" || status == "failed" {
            let err = resp.get("error").filter(|e| e.is_object());
            let message = err
                .and_then(|e| str_of(e, "message"))
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("The model server reported that the response failed.")
                .to_string();
            let code = err.and_then(code_of);
            let retryable = matches!(
                code.as_deref(),
                Some("server_error") | Some("server_overloaded") | Some("rate_limit_exceeded")
            );
            self.terminal = Some(Terminal::Failed(ResponsesFailure {
                status: None,
                retry_after_ms: retry_after_from_message(&message),
                code,
                message,
                retryable,
                server_raw: err.map(|e| truncate(&e.to_string(), SERVER_RAW_MAX)),
            }));
            return;
        }
        if let Some(items) = resp.get("output").and_then(Value::as_array) {
            for (index, item) in items.iter().enumerate() {
                self.item_done(item, Some(index as u64), out);
            }
        }
        self.flush_calls(out);
        let usage = resp.get("usage");
        let input_tokens = usage.and_then(|u| u.get("input_tokens").or(u.get("prompt_tokens"))).and_then(Value::as_u64);
        let output_tokens = usage
            .and_then(|u| u.get("output_tokens").or(u.get("completion_tokens")))
            .and_then(Value::as_u64);
        let cached_tokens = usage
            .and_then(|u| u.get("input_tokens_details").or(u.get("prompt_tokens_details")))
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64);
        let reason = resp
            .get("incomplete_details")
            .and_then(|d| str_of(d, "reason"))
            .unwrap_or("");
        let finish_reason = if status == "incomplete" && reason == "content_filter" {
            "content_filter"
        } else if status == "incomplete" {
            "length"
        } else if !self.calls.is_empty() {
            "tool_calls"
        } else {
            "stop"
        };
        // Only a clean completion is a base for `previous_response_id`: never
        // `created`, never `[DONE]`, never an incomplete or failed one.
        let commit = (ty == "response.completed" && status == "completed")
            .then(|| self.response_id.clone())
            .flatten();
        out.push(ResponsesStreamEvent::Completed {
            response_id: self.response_id.clone(),
            model: self.model.clone(),
            status,
            finish_reason: Some(finish_reason.to_string()),
            input_tokens,
            output_tokens,
            cached_tokens,
            transport: self.transport.to_string(),
        });
        self.terminal = Some(Terminal::Completed { commit });
    }
}

// ---------------------------------------------------------------------------
// Failures from the wire
// ---------------------------------------------------------------------------

fn retry_after_from_headers(get: impl Fn(&str) -> Option<String>) -> Option<u64> {
    let parse = |v: String| v.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0);
    if let Some(ms) = get("retry-after-ms").and_then(parse) {
        return Some(ms.ceil() as u64);
    }
    get("retry-after").and_then(parse).map(|s| (s * 1000.0).ceil() as u64)
}

/// "Please try again in 1.5s" / "in 20ms", as OpenAI words its rate limits.
fn retry_after_from_message(message: &str) -> Option<u64> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?i)try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b")
            .expect("static retry pattern")
    });
    let caps = re.captures(message)?;
    let n: f64 = caps.get(1)?.as_str().parse().ok()?;
    let unit = caps.get(2)?.as_str().to_ascii_lowercase();
    Some(if unit.starts_with("ms") || unit.starts_with("milli") {
        n.ceil() as u64
    } else {
        (n * 1000.0).ceil() as u64
    })
}

/// A non-2xx HTTP answer (or a refused WebSocket upgrade) as a failure.
pub(crate) fn failure_from_http(status: u16, retry_after_ms: Option<u64>, body: &str) -> ResponsesFailure {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let err = parsed
        .as_ref()
        .map(|v| v.get("error").filter(|e| e.is_object()).unwrap_or(v));
    let trimmed = body.trim();
    let message = err
        .and_then(|e| str_of(e, "message"))
        .map(str::to_string)
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|v| str_of(v, "error"))
                .map(str::to_string)
        })
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| {
            if trimmed.is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {}", truncate(trimmed, 300))
            }
        });
    let code = err.and_then(code_of);
    ResponsesFailure {
        status: Some(status),
        code,
        retry_after_ms: retry_after_ms.or_else(|| retry_after_from_message(&message)),
        retryable: matches!(status, 408 | 409 | 429) || status >= 500,
        server_raw: (!trimmed.is_empty()).then(|| truncate(trimmed, SERVER_RAW_MAX)),
        message,
    }
}

/// `{"type":"error","status":429,"error":{…},"headers":{…}}`, the error
/// frame of the Responses WebSocket (and of some SSE servers).
fn failure_from_error_frame(frame: &Value) -> ResponsesFailure {
    let err = frame.get("error").filter(|e| e.is_object()).unwrap_or(frame);
    let status = frame
        .get("status")
        .or(frame.get("status_code"))
        .and_then(Value::as_u64)
        .and_then(|s| u16::try_from(s).ok());
    let message = str_of(err, "message")
        .or(str_of(frame, "message"))
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("The model server reported an error.")
        .to_string();
    let code = code_of(err);
    let headers = frame.get("headers");
    let from_headers = retry_after_from_headers(|name| {
        headers
            .and_then(|h| h.get(name))
            .and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
    });
    let retryable = status.is_some_and(|s| matches!(s, 408 | 409 | 429) || s >= 500)
        || matches!(
            code.as_deref(),
            Some("server_error")
                | Some("server_overloaded")
                | Some("rate_limit_exceeded")
                | Some("websocket_connection_limit_reached")
        );
    ResponsesFailure {
        status,
        retry_after_ms: from_headers.or_else(|| retry_after_from_message(&message)),
        code,
        message,
        retryable,
        server_raw: Some(truncate(&frame.to_string(), SERVER_RAW_MAX)),
    }
}

/// A transport failure, worded so the renderer recognises it
/// (`isLocalTransportFailure`: "error sending request" plus host:port) and
/// replaces it with a plain sentence. The URL is the HTTP form, redacted, and
/// no Rust command name is in the text.
fn transport_failure(http_url: &str, detail: &str) -> ResponsesFailure {
    ResponsesFailure::new(
        "transport",
        format!("error sending request for url ({}): {}", redact_url(http_url), detail),
        true,
    )
}

fn reqwest_failure(http_url: &str, e: &reqwest::Error, visible: bool) -> ResponsesFailure {
    let mut text = os_error::english(e);
    if let Ok(full) = url::Url::parse(http_url) {
        text = text.replace(full.as_str(), &redact_url(http_url));
    }
    if visible {
        return ResponsesFailure::new(
            "stream_broken",
            format!("the connection to {} broke off during the answer: {}", redact_url(http_url), text),
            false,
        );
    }
    if text.contains("error sending request") {
        ResponsesFailure::new("transport", text, true)
    } else {
        transport_failure(http_url, &text)
    }
}

fn ws_failure(spec: &TurnSpec, detail: &str, visible: bool) -> ResponsesFailure {
    if visible {
        ResponsesFailure::new(
            "stream_broken",
            format!(
                "the WebSocket to {} broke off during the answer: {}",
                redact_url(&spec.http_url),
                detail
            ),
            false,
        )
    } else {
        transport_failure(&spec.http_url, detail)
    }
}

fn watchdog_failure(spec: &TurnSpec, meaningful: bool) -> ResponsesFailure {
    if meaningful {
        ResponsesFailure::new(
            "stream_idle",
            format!(
                "the backend stopped sending data (nothing for {} s). The model server may have crashed or been killed; check that it is still running and try again.",
                spec.idle.as_secs()
            ),
            false,
        )
    } else {
        ResponsesFailure::new(
            FIRST_REPLY_TIMEOUT,
            format!(
                "the backend accepted the request but sent nothing for {} s. A very large model or a very long prompt can take this long; raise Chat Reply Timeout in Settings, General, or restart the backend if it is not working.",
                spec.first_window.as_secs()
            ),
            false,
        )
    }
}

fn is_chain_rejection(f: &ResponsesFailure) -> bool {
    f.code.as_deref() == Some("previous_response_not_found")
        || f.message.contains("previous_response")
        || f.server_raw.as_deref().is_some_and(|raw| raw.contains("previous_response_id"))
}

fn classify_ws_failure(f: &ResponsesFailure, chained: bool, visible: bool) -> FailKind {
    if chained && !visible && is_chain_rejection(f) {
        return FailKind::ChainRejected;
    }
    if f.code.as_deref() == Some("websocket_connection_limit_reached")
        || f.status.is_some_and(|s| s >= 500)
        || matches!(f.code.as_deref(), Some("server_error") | Some("server_overloaded"))
    {
        return FailKind::Retryable;
    }
    FailKind::Final
}

// ---------------------------------------------------------------------------
// HTTP SSE turn
// ---------------------------------------------------------------------------

enum Step {
    Continue,
    End(Result<TurnEnd, TurnFailure>),
}

fn deliver(
    acc: &mut ResponsesEventAccumulator,
    events: Vec<ResponsesStreamEvent>,
    token: &CancellationToken,
    sink: Sink<'_>,
) -> Step {
    for ev in events {
        if token.is_cancelled() {
            return Step::End(Ok(TurnEnd::Cancelled));
        }
        if !sink(ev) {
            return Step::End(Ok(TurnEnd::SinkGone));
        }
    }
    match acc.terminal.take() {
        None => Step::Continue,
        Some(Terminal::Completed { commit }) => Step::End(Ok(TurnEnd::Completed { commit })),
        Some(Terminal::Failed(failure)) => Step::End(Err(TurnFailure {
            failure,
            visible: acc.visible,
            kind: FailKind::Final,
        })),
    }
}

/// One turn over `POST …/responses` with `stream: true`.
pub(crate) async fn sse_turn(
    client: &reqwest::Client,
    spec: &TurnSpec,
    token: &CancellationToken,
    sink: Sink<'_>,
) -> Result<TurnEnd, TurnFailure> {
    let fail = |failure: ResponsesFailure, visible: bool| TurnFailure {
        failure,
        visible,
        kind: FailKind::Final,
    };
    // Deterministic, not a select! race: a token that starts cancelled (a
    // CancelRegistry tombstone) never lets the request go out.
    if token.is_cancelled() {
        return Ok(TurnEnd::Cancelled);
    }
    let mut body = spec.body.clone();
    body.insert("stream".to_string(), Value::Bool(true));
    let payload = serde_json::to_vec(&Value::Object(body)).unwrap_or_default();
    let mut request = client.post(&spec.http_url);
    let mut has_content_type = false;
    let mut has_accept = false;
    for (k, v) in &spec.headers {
        has_content_type |= k.eq_ignore_ascii_case("content-type");
        has_accept |= k.eq_ignore_ascii_case("accept");
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            request = request.header(name, value);
        }
    }
    if !has_content_type {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
    }
    if !has_accept {
        request = request.header(reqwest::header::ACCEPT, "text/event-stream");
    }
    request = request.body(payload);

    let resp = tokio::select! {
        biased;
        _ = token.cancelled() => return Ok(TurnEnd::Cancelled),
        r = tokio::time::timeout(spec.first_window, request.send()) => match r {
            Err(_) => return Err(fail(watchdog_failure(spec, false), false)),
            Ok(Err(e)) => return Err(fail(reqwest_failure(&spec.http_url, &e, false), false)),
            Ok(Ok(resp)) => resp,
        },
    };

    let status = resp.status();
    if !status.is_success() {
        let retry = retry_after_from_headers(|name| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        });
        let text = tokio::select! {
            biased;
            _ = token.cancelled() => return Ok(TurnEnd::Cancelled),
            r = tokio::time::timeout(WS_CONNECT_LIMIT, resp.text()) => r.ok().and_then(Result::ok).unwrap_or_default(),
        };
        return Err(fail(failure_from_http(status.as_u16(), retry, &text), false));
    }

    if let Some(mode) = resp
        .headers()
        .get("x-lu-chat-billing")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_ascii_lowercase())
    {
        if (mode == "flash" || mode == "credits") && !sink(ResponsesStreamEvent::Billing { mode }) {
            return Ok(TurnEnd::SinkGone);
        }
    }

    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().contains("application/json"));
    let mut acc = ResponsesEventAccumulator::new("sse");

    // A proxy (or a server) that ignores `stream: true` and answers with the
    // whole response object at once.
    if is_json {
        let text = tokio::select! {
            biased;
            _ = token.cancelled() => return Ok(TurnEnd::Cancelled),
            r = tokio::time::timeout(spec.first_window, resp.text()) => match r {
                Err(_) => return Err(fail(watchdog_failure(spec, false), false)),
                Ok(Err(e)) => return Err(fail(reqwest_failure(&spec.http_url, &e, false), false)),
                Ok(Ok(text)) => text,
            },
        };
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            fail(
                ResponsesFailure::new(
                    "bad_response",
                    "The model server answered with JSON that is not a Responses API object.",
                    false,
                ),
                false,
            )
        })?;
        let events = acc.process(None, &value);
        return match deliver(&mut acc, events, token, sink) {
            Step::End(result) => result,
            Step::Continue => Err(fail(
                ResponsesFailure::new(
                    "bad_response",
                    "The model server answered with JSON that is not a Responses API object.",
                    false,
                ),
                acc.visible,
            )),
        };
    }

    let mut decoder = SseLineDecoder::default();
    let mut stream = resp.bytes_stream();
    let mut deadline = tokio::time::Instant::now() + spec.first_window;
    loop {
        let item = tokio::select! {
            biased;
            // Stop → `stream` and `resp` drop → the connection closes → the
            // server stops generating.
            _ = token.cancelled() => return Ok(TurnEnd::Cancelled),
            _ = tokio::time::sleep_until(deadline) => {
                return Err(fail(watchdog_failure(spec, acc.meaningful), acc.visible));
            }
            item = stream.next() => item,
        };
        let (frames, eof) = match item {
            None => (decoder.finish(), true),
            Some(Err(e)) => return Err(fail(reqwest_failure(&spec.http_url, &e, acc.visible), acc.visible)),
            Some(Ok(bytes)) => (decoder.push(&bytes), false),
        };
        for frame in frames {
            if frame.data.trim() == "[DONE]" {
                let mut events = Vec::new();
                if !acc.finish_without_terminal(&mut events) {
                    return Err(fail(
                        ResponsesFailure::new(
                            "bad_response",
                            "The model server ended the stream without sending a response.",
                            !acc.visible,
                        ),
                        acc.visible,
                    ));
                }
                if let Step::End(result) = deliver(&mut acc, events, token, sink) {
                    return result;
                }
                continue;
            }
            let value: Value = match serde_json::from_str(&frame.data) {
                Ok(v) => v,
                Err(_) => {
                    tracing::debug!(endpoint = %redact_url(&spec.http_url), "skipping a Responses SSE frame that is not JSON");
                    continue;
                }
            };
            let events = acc.process(frame.event.as_deref(), &value);
            if let Step::End(result) = deliver(&mut acc, events, token, sink) {
                return result;
            }
        }
        if eof {
            let failure = if acc.visible {
                ResponsesFailure::new(
                    "stream_broken",
                    format!(
                        "the connection to {} closed before the response finished.",
                        redact_url(&spec.http_url)
                    ),
                    false,
                )
            } else {
                transport_failure(&spec.http_url, "the server closed the stream before it sent a response")
            };
            return Err(fail(failure, acc.visible));
        }
        if acc.meaningful {
            deadline = tokio::time::Instant::now() + spec.idle;
        }
    }
}

// ---------------------------------------------------------------------------
// WebSocket turn, chaining, session cache
// ---------------------------------------------------------------------------

type WsConn = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The committed base of the next chained turn.
#[derive(Debug, Clone)]
pub(crate) struct LastResponse {
    pub(crate) response_id: String,
    /// model + instructions + tools of that turn.
    pub(crate) fingerprint: Value,
    /// The full input the caller sent for that turn.
    pub(crate) full_input: Vec<Value>,
    /// What the model produced, to recognise its echo in the next input.
    pub(crate) text: String,
    pub(crate) call_ids: Vec<String>,
}

/// One cached socket and the chain that lives on it. `store: false`
/// responses only exist in the connection's own cache, so the chain is
/// dropped with the connection, always together.
#[derive(Default)]
pub(crate) struct WsSlot {
    conn: Option<WsConn>,
    last: Option<LastResponse>,
    /// The server refused `previous_response_id` once on this session (a
    /// server without a per-connection cache, or one that kept nothing
    /// because of `store: false`). Every later turn sends the full input
    /// right away instead of paying the refusal again.
    chain_refused: bool,
}

const CHAIN_KEYS: [&str; 3] = ["model", "instructions", "tools"];

fn chain_fingerprint(params: &Map<String, Value>) -> Value {
    let mut m = Map::new();
    for k in CHAIN_KEYS {
        m.insert(k.to_string(), params.get(k).cloned().unwrap_or(Value::Null));
    }
    Value::Object(m)
}

fn normalized_input(body: &Map<String, Value>) -> Vec<Value> {
    match body.get("input") {
        Some(Value::String(s)) => vec![json!({"role": "user", "content": s})],
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

enum Echo {
    Text(String),
    Call(String),
    Reasoning,
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| str_of(p, "text").or(str_of(p, "refusal")))
            .collect(),
        _ => String::new(),
    }
}

fn echo_kind(item: &Value) -> Option<Echo> {
    match str_of(item, "type") {
        Some("function_call") => Some(Echo::Call(str_of(item, "call_id").unwrap_or("").to_string())),
        Some("reasoning") => Some(Echo::Reasoning),
        Some("message") | None if str_of(item, "role") == Some("assistant") => {
            Some(Echo::Text(content_text(item.get("content"))))
        }
        _ => None,
    }
}

/// The input items that are new since `last`, when the server can be asked
/// to continue `last` instead of reading the whole conversation again.
///
/// Strict on purpose: same model, instructions and tools; the earlier input
/// as an exact prefix; then exactly what the model produced (its text and
/// its tool call ids, reasoning items skipped) as the client's echo; and at
/// least one item after that. Anything else sends the full input, which
/// costs tokens but can never continue the wrong conversation.
pub(crate) fn chain_delta(last: &LastResponse, fingerprint: &Value, full_input: &[Value]) -> Option<Vec<Value>> {
    if &last.fingerprint != fingerprint || full_input.len() <= last.full_input.len() {
        return None;
    }
    if full_input[..last.full_input.len()] != last.full_input[..] {
        return None;
    }
    let rest = &full_input[last.full_input.len()..];
    let mut i = 0;
    let mut echoed_text = String::new();
    let mut echoed_calls: Vec<String> = Vec::new();
    while i < rest.len() {
        match echo_kind(&rest[i]) {
            Some(Echo::Text(t)) => echoed_text.push_str(&t),
            Some(Echo::Call(id)) => echoed_calls.push(id),
            Some(Echo::Reasoning) => {}
            None => break,
        }
        i += 1;
    }
    if echoed_text.trim() != last.text.trim() || echoed_calls != last.call_ids {
        return None;
    }
    let delta = rest[i..].to_vec();
    (!delta.is_empty()).then_some(delta)
}

/// What a chained turn commits once it completes cleanly.
struct Staged {
    fingerprint: Value,
    full_input: Vec<Value>,
}

/// The `response.create` frame for one turn, plus what it may commit and
/// whether it continues a chain.
///
/// `instructions` stay in a chained frame: the server does not carry them
/// over from the previous response, and a frame without them would answer
/// without the system prompt.
fn build_ws_envelope(body: &Map<String, Value>, last: Option<&LastResponse>, allow_chain: bool) -> (Value, Option<Staged>, bool) {
    let mut params = body.clone();
    params.remove("stream");
    let input = params.remove("input").unwrap_or(Value::Array(Vec::new()));
    let caller_chain = params
        .get("previous_response_id")
        .is_some_and(|v| !v.is_null());
    let fingerprint = chain_fingerprint(&params);
    let full_input = normalized_input(body);
    let mut envelope = Map::new();
    envelope.insert("type".to_string(), json!("response.create"));
    let mut chained = false;
    let mut input_out = input;
    if !caller_chain {
        params.remove("previous_response_id");
        if allow_chain {
            if let Some(last) = last {
                if let Some(delta) = chain_delta(last, &fingerprint, &full_input) {
                    params.insert("previous_response_id".to_string(), json!(last.response_id));
                    input_out = Value::Array(delta);
                    chained = true;
                }
            }
        }
    }
    for (k, v) in params {
        envelope.insert(k, v);
    }
    envelope.insert("input".to_string(), input_out);
    // A caller that manages `previous_response_id` itself owns the chain;
    // nothing is staged for it.
    let staged = (!caller_chain).then_some(Staged {
        fingerprint,
        full_input,
    });
    (Value::Object(envelope), staged, chained)
}

/// A cached socket is reused only when nothing says it is dead. Pending
/// frames of an idle socket (a ping, a late event of an old turn) are drained
/// without waiting.
fn socket_still_open(conn: &mut WsConn) -> bool {
    loop {
        match conn.next().now_or_never() {
            None => return true,
            Some(None) | Some(Some(Err(_))) | Some(Some(Ok(Message::Close(_)))) => return false,
            Some(Some(Ok(_))) => continue,
        }
    }
}

fn build_ws_request(spec: &TurnSpec) -> Result<tungstenite::handshake::client::Request, ResponsesFailure> {
    let mut request = spec
        .ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| ResponsesFailure::new("refused", format!("Invalid Responses WebSocket URL: {e}"), false))?;
    let headers = request.headers_mut();
    for (k, v) in &spec.headers {
        let lower = k.to_ascii_lowercase();
        if lower == "content-type" || lower == "accept" {
            continue;
        }
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            headers.insert(name, value);
        }
    }
    let beta = match headers.get("openai-beta").and_then(|v| v.to_str().ok()) {
        Some(existing) if existing.contains("responses_websockets") => existing.to_string(),
        Some(existing) => format!("{existing}, {OPENAI_BETA_WS}"),
        None => OPENAI_BETA_WS.to_string(),
    };
    if let Ok(value) = HeaderValue::from_str(&beta) {
        headers.insert("openai-beta", value);
    }
    Ok(request)
}

fn classify_connect_error(spec: &TurnSpec, e: tungstenite::Error) -> TurnFailure {
    match e {
        tungstenite::Error::Http(resp) => {
            let status = resp.status().as_u16();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default();
            let retry = retry_after_from_headers(|name| {
                resp.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            });
            let failure = failure_from_http(status, retry, &body);
            let kind = if FALLBACK_STATUSES.contains(&status) {
                FailKind::Unsupported
            } else if status >= 500 {
                FailKind::Retryable
            } else {
                FailKind::Final
            };
            TurnFailure { failure, visible: false, kind }
        }
        // The server answered, but not with an upgrade (200 with a page,
        // missing accept key, …): it does not speak the WebSocket.
        tungstenite::Error::Protocol(p) => TurnFailure {
            failure: ResponsesFailure::new(
                "ws_unsupported",
                format!(
                    "the server at {} did not accept a WebSocket upgrade ({p})",
                    redact_url(&spec.http_url)
                ),
                false,
            ),
            visible: false,
            kind: FailKind::Unsupported,
        },
        tungstenite::Error::Url(u) => TurnFailure {
            failure: ResponsesFailure::new("refused", format!("Invalid Responses WebSocket URL: {u}"), false),
            visible: false,
            kind: FailKind::Final,
        },
        other => TurnFailure {
            failure: transport_failure(&spec.http_url, &os_error::english(&other)),
            visible: false,
            kind: FailKind::Retryable,
        },
    }
}

async fn ws_connect(spec: &TurnSpec, token: &CancellationToken) -> Result<Option<WsConn>, TurnFailure> {
    let request = build_ws_request(spec).map_err(|failure| TurnFailure {
        failure,
        visible: false,
        kind: FailKind::Final,
    })?;
    let limit = spec.first_window.min(WS_CONNECT_LIMIT);
    let connected = tokio::select! {
        biased;
        _ = token.cancelled() => return Ok(None),
        r = tokio::time::timeout(limit, tokio_tungstenite::connect_async_with_config(request, None, false)) => r,
    };
    match connected {
        Err(_) => Err(TurnFailure {
            failure: transport_failure(
                &spec.http_url,
                &format!("the WebSocket handshake did not finish within {} s", limit.as_secs()),
            ),
            visible: false,
            kind: FailKind::Retryable,
        }),
        Ok(Ok((conn, _response))) => Ok(Some(conn)),
        Ok(Err(e)) => Err(classify_connect_error(spec, e)),
    }
}

/// One turn on the slot's socket (opened when there is none).
async fn ws_turn(
    slot: &mut WsSlot,
    spec: &TurnSpec,
    token: &CancellationToken,
    sink: Sink<'_>,
    allow_chain: bool,
) -> Result<TurnEnd, TurnFailure> {
    if token.is_cancelled() {
        return Ok(TurnEnd::Cancelled);
    }
    // Taken out of the slot for the turn: every failure path drops it (and
    // with it the server's cache of this chain), only a clean completion puts
    // it back.
    let cached = match slot.conn.take() {
        Some(mut conn) => socket_still_open(&mut conn).then_some(conn),
        None => None,
    };
    let mut conn = match cached {
        Some(conn) => conn,
        None => {
            slot.last = None;
            match ws_connect(spec, token).await? {
                Some(conn) => conn,
                None => return Ok(TurnEnd::Cancelled),
            }
        }
    };
    let (envelope, staged, chained) =
        build_ws_envelope(&spec.body, slot.last.as_ref(), allow_chain && !slot.chain_refused);
    let mut staged = staged;
    // Consumed: only this turn's clean completion commits again.
    slot.last = None;

    let sent = tokio::select! {
        biased;
        _ = token.cancelled() => return Ok(TurnEnd::Cancelled),
        r = tokio::time::timeout(WS_CONNECT_LIMIT, conn.send(Message::text(envelope.to_string()))) => r,
    };
    match sent {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            return Err(TurnFailure {
                failure: ws_failure(spec, &os_error::english(&e), false),
                visible: false,
                kind: FailKind::Retryable,
            })
        }
        Err(_) => {
            return Err(TurnFailure {
                failure: ws_failure(spec, "the WebSocket did not take the request in time", false),
                visible: false,
                kind: FailKind::Retryable,
            })
        }
    }

    let mut acc = ResponsesEventAccumulator::new("websocket");
    let started = tokio::time::Instant::now();
    let mut deadline = started + spec.first_window;
    let mut ping = tokio::time::interval_at(started + WS_PING_EVERY, WS_PING_EVERY);
    let broken = |acc: &ResponsesEventAccumulator, detail: &str| TurnFailure {
        failure: ws_failure(spec, detail, acc.visible),
        visible: acc.visible,
        kind: if acc.visible { FailKind::Final } else { FailKind::Retryable },
    };
    loop {
        let msg = tokio::select! {
            biased;
            _ = token.cancelled() => return Ok(TurnEnd::Cancelled),
            _ = tokio::time::sleep_until(deadline) => {
                return Err(TurnFailure {
                    failure: watchdog_failure(spec, acc.meaningful),
                    visible: acc.visible,
                    kind: FailKind::Final,
                });
            }
            _ = ping.tick() => {
                match tokio::time::timeout(WS_CONNECT_LIMIT, conn.send(Message::Ping(Default::default()))).await {
                    Ok(Ok(())) => continue,
                    Ok(Err(e)) => return Err(broken(&acc, &os_error::english(&e))),
                    Err(_) => return Err(broken(&acc, "the WebSocket stopped taking frames")),
                }
            }
            m = conn.next() => m,
        };
        match msg {
            None => return Err(broken(&acc, "the server closed the WebSocket")),
            Some(Err(e)) => return Err(broken(&acc, &os_error::english(&e))),
            Some(Ok(Message::Close(frame))) => {
                let reason = frame
                    .map(|f| f.reason.as_str().to_string())
                    .filter(|r| !r.is_empty())
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default();
                return Err(broken(&acc, &format!("the server closed the WebSocket{reason}")));
            }
            Some(Ok(Message::Text(text))) => {
                let value: Value = match serde_json::from_str(text.as_str()) {
                    Ok(v) => v,
                    Err(_) => {
                        tracing::debug!(endpoint = %spec.endpoint_key, "skipping a Responses WebSocket frame that is not JSON");
                        continue;
                    }
                };
                let events = acc.process(None, &value);
                for ev in events {
                    if token.is_cancelled() {
                        return Ok(TurnEnd::Cancelled);
                    }
                    if !sink(ev) {
                        return Ok(TurnEnd::SinkGone);
                    }
                }
                if acc.meaningful {
                    deadline = tokio::time::Instant::now() + spec.idle;
                }
                match acc.terminal.take() {
                    None => {}
                    Some(Terminal::Completed { commit }) => {
                        if let (Some(id), Some(staged)) = (commit.clone(), staged.take()) {
                            slot.last = Some(LastResponse {
                                response_id: id,
                                fingerprint: staged.fingerprint,
                                full_input: staged.full_input,
                                text: acc.text_out.clone(),
                                call_ids: acc.call_ids_out.clone(),
                            });
                        }
                        slot.conn = Some(conn);
                        return Ok(TurnEnd::Completed { commit });
                    }
                    Some(Terminal::Failed(failure)) => {
                        let kind = classify_ws_failure(&failure, chained, acc.visible);
                        return Err(TurnFailure {
                            failure,
                            visible: acc.visible,
                            kind,
                        });
                    }
                }
            }
            // Ping (answered by tungstenite on the next read), Pong, Binary.
            Some(Ok(_)) => {}
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    endpoint: String,
    auth: String,
    session: String,
}

struct SlotEntry {
    slot: Arc<tokio::sync::Mutex<WsSlot>>,
    used: u64,
}

#[derive(Default)]
struct RegistryInner {
    slots: HashMap<SessionKey, SlotEntry>,
    tick: u64,
    ws_unsupported: VecDeque<String>,
}

/// Cached Responses WebSockets, one per (endpoint, credentials, chat
/// session), plus the endpoints known to refuse the upgrade.
#[derive(Default)]
pub struct ResponsesSessionRegistry {
    inner: Mutex<RegistryInner>,
}

impl ResponsesSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn slot(&self, key: SessionKey) -> Arc<tokio::sync::Mutex<WsSlot>> {
        let mut guard = self.lock();
        let inner = &mut *guard;
        inner.tick += 1;
        let tick = inner.tick;
        if let Some(entry) = inner.slots.get_mut(&key) {
            entry.used = tick;
            return entry.slot.clone();
        }
        if inner.slots.len() >= MAX_SESSIONS {
            let oldest = inner
                .slots
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                inner.slots.remove(&oldest);
            }
        }
        let slot = Arc::new(tokio::sync::Mutex::new(WsSlot::default()));
        inner.slots.insert(key, SlotEntry { slot: slot.clone(), used: tick });
        slot
    }

    pub(crate) fn ws_unsupported(&self, endpoint: &str) -> bool {
        self.lock().ws_unsupported.iter().any(|e| e == endpoint)
    }

    pub(crate) fn mark_ws_unsupported(&self, endpoint: &str) {
        let mut guard = self.lock();
        if guard.ws_unsupported.iter().any(|e| e == endpoint) {
            return;
        }
        if guard.ws_unsupported.len() >= MAX_WS_UNSUPPORTED {
            guard.ws_unsupported.pop_front();
        }
        guard.ws_unsupported.push_back(endpoint.to_string());
    }

    /// Forget every socket of a chat session and close the idle ones. A
    /// socket in the middle of a turn finishes that turn and is dropped with
    /// it, since nobody can find it any more.
    pub async fn close_session(&self, session_id: &str) -> usize {
        let slots: Vec<Arc<tokio::sync::Mutex<WsSlot>>> = {
            let mut guard = self.lock();
            let keys: Vec<SessionKey> = guard
                .slots
                .keys()
                .filter(|k| k.session == session_id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|k| guard.slots.remove(&k))
                .map(|e| e.slot)
                .collect()
        };
        let count = slots.len();
        for slot in slots {
            if let Ok(mut idle) = slot.try_lock() {
                idle.last = None;
                if let Some(mut conn) = idle.conn.take() {
                    let _ = tokio::time::timeout(Duration::from_secs(2), conn.close(None)).await;
                }
            }
        }
        count
    }
}

/// The WebSocket side of a turn: the session's socket (or a socket of its own
/// when there is no session, or when another turn holds the session's), one
/// retry for a retryable failure before output, and one retry without the
/// chain when the server refused `previous_response_id`.
async fn run_ws(
    registry: &ResponsesSessionRegistry,
    spec: &TurnSpec,
    token: &CancellationToken,
    sink: Sink<'_>,
) -> Result<TurnEnd, TurnFailure> {
    let shared = spec
        .session_id
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            registry.slot(SessionKey {
                endpoint: spec.endpoint_key.clone(),
                auth: spec.auth_fingerprint.clone(),
                session: s.clone(),
            })
        });
    let mut guard = shared.and_then(|slot| slot.try_lock_owned().ok());
    let mut ephemeral = WsSlot::default();
    let slot: &mut WsSlot = match guard.as_mut() {
        Some(g) => &mut **g,
        None => &mut ephemeral,
    };
    let mut allow_chain = true;
    let mut attempts = 0usize;
    loop {
        attempts += 1;
        match ws_turn(slot, spec, token, sink, allow_chain).await {
            Ok(end) => return Ok(end),
            Err(f) if f.kind == FailKind::ChainRejected && allow_chain => {
                tracing::info!(endpoint = %spec.endpoint_key, "Responses chain refused by the server; resending the full input");
                allow_chain = false;
                slot.chain_refused = true;
            }
            Err(f) if f.kind == FailKind::Retryable && !f.visible && attempts < WS_MAX_ATTEMPTS => {
                tracing::debug!(endpoint = %spec.endpoint_key, code = ?f.failure.code, "Responses WebSocket attempt failed before output; retrying");
            }
            Err(f) => return Err(f),
        }
    }
}

/// One turn with the transport policy applied.
pub(crate) async fn run_turn(
    client: &reqwest::Client,
    registry: &ResponsesSessionRegistry,
    spec: &TurnSpec,
    transport: Transport,
    token: &CancellationToken,
    sink: Sink<'_>,
) -> Result<TurnEnd, TurnFailure> {
    match transport {
        Transport::Sse => sse_turn(client, spec, token, sink).await,
        Transport::WebSocket => run_ws(registry, spec, token, sink).await,
        Transport::Auto => {
            if registry.ws_unsupported(&spec.endpoint_key) {
                return sse_turn(client, spec, token, sink).await;
            }
            match run_ws(registry, spec, token, sink).await {
                // Trigger 1: the upgrade was refused.
                Err(f) if !f.visible && f.kind == FailKind::Unsupported => {
                    registry.mark_ws_unsupported(&spec.endpoint_key);
                    tracing::info!(endpoint = %spec.endpoint_key, "Responses WebSocket not offered here; using HTTP SSE");
                    sse_turn(client, spec, token, sink).await
                }
                // Trigger 2: the bounded retries ran out before any output.
                Err(f) if !f.visible && f.kind == FailKind::Retryable => {
                    tracing::info!(endpoint = %spec.endpoint_key, "Responses WebSocket kept failing before output; using HTTP SSE");
                    sse_turn(client, spec, token, sink).await
                }
                other => other,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn idle_window(setting_ms: Option<u64>) -> Duration {
    match setting_ms {
        None => DEFAULT_IDLE,
        Some(0) => FIRST_CHUNK_OFF,
        Some(ms) => Duration::from_millis(ms.max(1_000)).min(FIRST_CHUNK_OFF),
    }
}

struct Prepared {
    client: reqwest::Client,
    spec: TurnSpec,
    transport: Transport,
}

fn prepare(
    req: &ResponsesStreamRequest,
    state: &tauri::State<'_, crate::state::AppState>,
) -> Result<Prepared, ResponsesFailure> {
    let refused = |message: String| ResponsesFailure::new("refused", message, false);
    let transport = Transport::parse(req.transport.as_deref()).map_err(refused)?;
    let ends = responses_endpoints(&req.url).map_err(refused)?;
    let allow = ProxyAllowList::snapshot(state);
    allow.check_responses_url(&ends.http).map_err(refused)?;
    if transport != Transport::Sse {
        allow.check_responses_url(&ends.ws).map_err(refused)?;
    }
    let body = match serde_json::from_str::<Value>(&req.body_json) {
        Ok(Value::Object(map)) => map,
        _ => return Err(refused("The Responses request body is not a JSON object.".to_string())),
    };
    // A generation request may not name a model the engine is not holding.
    super::proxy::guard_builtin_model(&ends.http, Some(&req.body_json), state).map_err(refused)?;
    let ports = super::engine_key::engine_ports(state);
    let headers = outgoing_headers(&ends.http, req.headers.clone(), &ports);
    let fingerprint = auth_fingerprint(&headers);
    let first_window = super::proxy::first_chunk_window(req.first_chunk_timeout_ms, DEFAULT_FIRST_CHUNK);
    let idle = idle_window(req.idle_timeout_ms);
    let client = super::proxy::proxy_client(super::proxy::whole_request_limit(first_window), allow)
        .map_err(|e| ResponsesFailure::new("transport", e, true))?;
    Ok(Prepared {
        client,
        transport,
        spec: TurnSpec {
            endpoint_key: redact_url(&ends.ws),
            http_url: ends.http,
            ws_url: ends.ws,
            body,
            headers,
            auth_fingerprint: fingerprint,
            session_id: req.session_id.clone(),
            first_window,
            idle,
        },
    })
}

/// Stream one Responses API turn into `on_event`.
///
/// Always resolves `Ok(())`: a failure travels as an `Error` event (unless
/// the turn was cancelled, which is not a failure), and `Eof` is the last
/// event in every case.
#[tauri::command]
pub async fn responses_stream(
    req: ResponsesStreamRequest,
    on_event: tauri::ipc::Channel<ResponsesStreamEvent>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let stream_id = req
        .stream_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Registered before anything else can fail, so a cancel that raced ahead
    // of this command (a tombstone) is honoured and the Eof below is always
    // reached.
    let (token, _guard) = state.responses_tokens.register(stream_id);
    let sink = move |ev: ResponsesStreamEvent| on_event.send(ev).is_ok();
    let outcome = match prepare(&req, &state) {
        Err(failure) => Err(failure),
        Ok(prepared) => {
            let registry = state.responses_sessions.clone();
            run_turn(
                &prepared.client,
                &registry,
                &prepared.spec,
                prepared.transport,
                &token,
                &sink,
            )
            .await
            .map(|_| ())
            .map_err(|f| f.failure)
        }
    };
    if let Err(failure) = outcome {
        if !token.is_cancelled() {
            tracing::warn!(
                endpoint = %redact_url(&req.url),
                status = ?failure.status,
                code = ?failure.code,
                "Responses turn failed"
            );
            sink(failure.into_event());
        }
    }
    sink(ResponsesStreamEvent::Eof {});
    Ok(())
}

/// Cancel a running `responses_stream` by its `stream_id`. Also works when it
/// arrives before the stream registered (CancelRegistry tombstone).
#[tauri::command]
pub fn responses_cancel(
    stream_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    state.responses_tokens.cancel(&stream_id);
    Ok(())
}

/// Close and forget the cached WebSocket(s) of a chat session (chat deleted,
/// provider changed).
#[tauri::command]
pub async fn responses_close_session(
    session_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let registry = state.responses_sessions.clone();
    registry.close_session(&session_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    type Events = Arc<Mutex<Vec<ResponsesStreamEvent>>>;

    fn collector() -> (Events, impl Fn(ResponsesStreamEvent) -> bool + Send + Sync) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        (events, move |ev| {
            sink_events.lock().unwrap().push(ev);
            true
        })
    }

    fn body(input: Value) -> Map<String, Value> {
        match json!({"model": "gpt-test", "instructions": "Be brief.", "input": input, "store": false}) {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    fn spec(http_url: &str, ws_url: &str, input: Value) -> TurnSpec {
        TurnSpec {
            http_url: http_url.to_string(),
            ws_url: ws_url.to_string(),
            endpoint_key: redact_url(ws_url),
            body: body(input),
            headers: vec![("Authorization".to_string(), "Bearer sk-test-0123456789abcdef".to_string())],
            auth_fingerprint: "fp".to_string(),
            session_id: Some("chat-1".to_string()),
            first_window: Duration::from_secs(5),
            idle: Duration::from_secs(5),
        }
    }

    fn user(text: &str) -> Value {
        json!({"role": "user", "content": text})
    }

    fn assistant(text: &str) -> Value {
        json!({"role": "assistant", "content": text})
    }

    fn sse_crlf(ev: &Value) -> String {
        format!("event: {}\r\ndata: {}\r\n\r\n", ev["type"].as_str().unwrap(), ev)
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    async fn read_http_request(sock: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        loop {
            let n = sock.read(&mut tmp).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = find(&buf, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        if k.trim().eq_ignore_ascii_case("content-length") {
                            v.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                while buf.len() < pos + 4 + len {
                    let n = sock.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                break;
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    }

    /// A one-shot HTTP server that answers with an SSE body, cut into small
    /// pieces so chunk boundaries fall inside characters and `\r\n` pairs.
    async fn sse_server(payload: Vec<u8>, piece: usize) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut sock).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            for chunk in payload.chunks(piece) {
                sock.write_all(chunk).await.unwrap();
                sock.flush().await.unwrap();
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let _ = sock.shutdown().await;
            request
        });
        (format!("http://{addr}/v1/responses"), handle)
    }

    // -- framing --------------------------------------------------------------

    #[test]
    fn utf8_split_inside_a_character_crlf_and_comments_survive_the_decoder() {
        let raw = ": keep-alive\r\nevent: response.output_text.delta\r\ndata: {\"delta\":\"zażółć 🦀\"}\r\n\r\ndata: line one\ndata: line two\n\n".as_bytes();
        // One byte at a time: every multibyte character and every CRLF pair
        // is split.
        let mut decoder = SseLineDecoder::default();
        let mut frames = Vec::new();
        for b in raw {
            frames.extend(decoder.push(std::slice::from_ref(b)));
        }
        frames.extend(decoder.finish());
        assert_eq!(
            frames,
            vec![
                SseFrame {
                    event: Some("response.output_text.delta".to_string()),
                    data: "{\"delta\":\"zażółć 🦀\"}".to_string(),
                },
                SseFrame {
                    event: None,
                    data: "line one\nline two".to_string(),
                },
            ]
        );
        assert!(!frames.iter().any(|f| f.data.contains('\u{FFFD}')));
    }

    #[test]
    fn a_lone_cr_ends_a_line_and_a_trailing_frame_is_flushed_at_eof() {
        let mut decoder = SseLineDecoder::default();
        let mut frames = decoder.push(b"data: a\r\rdata: b");
        frames.extend(decoder.finish());
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "a");
        assert_eq!(frames[1].data, "b");
    }

    // -- endpoints, allow-list, redaction -------------------------------------

    #[test]
    fn endpoints_append_responses_once_and_map_the_scheme() {
        let e = responses_endpoints("https://api.openai.com/v1").unwrap();
        assert_eq!(e.http, "https://api.openai.com/v1/responses");
        assert_eq!(e.ws, "wss://api.openai.com/v1/responses");
        let e = responses_endpoints("http://127.0.0.1:8129/v1/").unwrap();
        assert_eq!(e.http, "http://127.0.0.1:8129/v1/responses");
        assert_eq!(e.ws, "ws://127.0.0.1:8129/v1/responses");
        let e = responses_endpoints("wss://example.test/openai/v1/responses?api-version=1").unwrap();
        assert_eq!(e.http, "https://example.test/openai/v1/responses?api-version=1");
        assert_eq!(e.ws, "wss://example.test/openai/v1/responses?api-version=1");
        assert!(responses_endpoints("ftp://example.test/v1").is_err());
    }

    #[test]
    fn the_websocket_url_is_held_to_the_rules_of_its_http_twin() {
        let desk = ProxyAllowList::for_tests(false, &["api.openai.com"]);
        assert!(desk.check_responses_url("wss://api.openai.com/v1/responses").is_ok());
        assert!(desk.check_responses_url("ws://127.0.0.1:8129/v1/responses").is_ok());
        assert!(desk.check_responses_url("ws://169.254.169.254/latest/meta-data").is_err());
        assert!(desk.check_responses_url("wss://[::ffff:169.254.169.254]/x").is_err());
        assert!(desk.check_responses_url("ws://[fd00:ec2::254]/x").is_err());
        assert!(desk.check_responses_url("ftp://api.openai.com/v1").is_err());
        let refused = desk
            .check_responses_url("wss://unregistered.example.com/v1/responses")
            .unwrap_err();
        assert!(!refused.contains("proxy_localhost"), "{refused}");

        let phone = ProxyAllowList::for_tests(true, &["api.openai.com"]);
        assert!(phone.check_responses_url("ws://api.openai.com/v1/responses").is_err());
        assert!(phone.check_responses_url("http://api.openai.com/v1/responses").is_err());
        assert!(phone.check_responses_url("wss://api.openai.com/v1/responses").is_ok());
    }

    #[test]
    fn secrets_are_scrubbed_from_messages() {
        let raw = "upstream said: Authorization: Bearer sk-proj-ABCDEFGHIJKLMNOPQRST, \
                   then Bearer abcdefghijklmnop and https://x.test/v1/responses?api_key=hunter2&x=1 \
                   key lu_0123456789abcdefABCD";
        let clean = redact_secrets(raw);
        assert!(!clean.contains("sk-proj-ABCDEFGHIJKLMNOPQRST"), "{clean}");
        assert!(!clean.contains("abcdefghijklmnop"), "{clean}");
        assert!(!clean.contains("hunter2"), "{clean}");
        assert!(!clean.contains("lu_0123456789abcdefABCD"), "{clean}");
        assert!(clean.contains("x=1"), "{clean}");
        assert!(clean.contains("[REDACTED]"));
        let ev = ResponsesFailure::new("auth", "Incorrect API key provided: sk-live-0123456789abcdef", false).into_event();
        match ev {
            ResponsesStreamEvent::Error { message, .. } => assert!(!message.contains("sk-live-0123456789abcdef")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hop_by_hop_and_websocket_headers_never_go_out() {
        let mut caller = HashMap::new();
        caller.insert("Authorization".to_string(), "Bearer sk-abc".to_string());
        caller.insert("Host".to_string(), "evil".to_string());
        caller.insert("Sec-WebSocket-Key".to_string(), "x".to_string());
        caller.insert("Connection".to_string(), "close".to_string());
        caller.insert("OpenAI-Project".to_string(), "proj_1".to_string());
        let out = outgoing_headers("https://api.openai.com/v1/responses", Some(caller), &[]);
        let names: Vec<String> = out.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
        assert_eq!(names, vec!["authorization", "openai-project"]);
        assert_ne!(auth_fingerprint(&out), "anon");
        assert!(!auth_fingerprint(&out).contains("sk-abc"));
    }

    // -- event mapping ---------------------------------------------------------

    #[test]
    fn text_sent_only_in_done_events_is_emitted_once() {
        let mut acc = ResponsesEventAccumulator::new("sse");
        let mut events = acc.process(None, &json!({"type":"response.output_text.done","item_id":"msg_1","text":"Hello"}));
        events.extend(acc.process(None, &json!({"type":"response.output_item.done","item":{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"Hello"}]}})));
        events.extend(acc.process(None, &json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"Hello"}]}]}})));
        let texts: Vec<&ResponsesStreamEvent> = events
            .iter()
            .filter(|e| matches!(e, ResponsesStreamEvent::TextDelta { .. }))
            .collect();
        assert_eq!(texts.len(), 1);
        assert!(matches!(acc.terminal, Some(Terminal::Completed { commit: Some(ref id) }) if id == "r1"));
    }

    #[test]
    fn a_bare_response_object_is_mapped_and_an_incomplete_one_is_never_a_chain_base() {
        let mut acc = ResponsesEventAccumulator::new("sse");
        let events = acc.process(
            None,
            &json!({
                "object": "response", "id": "r2", "model": "m", "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [
                    {"type": "message", "id": "m1", "content": [{"type": "output_text", "text": "Hi"}]},
                    {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "f", "arguments": "{\"a\":1}"}
                ],
                "usage": {"input_tokens": 5, "output_tokens": 2}
            }),
        );
        assert!(events.contains(&ResponsesStreamEvent::TextDelta { delta: "Hi".into(), item_id: Some("m1".into()) }));
        assert!(events.contains(&ResponsesStreamEvent::FunctionCallDone {
            item_id: Some("fc1".into()),
            call_id: "c1".into(),
            name: "f".into(),
            arguments: "{\"a\":1}".into()
        }));
        match events.last() {
            Some(ResponsesStreamEvent::Completed { status, finish_reason, input_tokens, .. }) => {
                assert_eq!(status, "incomplete");
                assert_eq!(finish_reason.as_deref(), Some("length"));
                assert_eq!(*input_tokens, Some(5));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(acc.terminal, Some(Terminal::Completed { commit: None })));
    }

    #[test]
    fn a_failed_response_is_terminal_and_emits_no_completion() {
        let mut acc = ResponsesEventAccumulator::new("websocket");
        let events = acc.process(None, &json!({"type":"response.failed","response":{"id":"r3","status":"failed","error":{"code":"server_error","message":"boom"}}}));
        assert!(events.is_empty());
        match acc.terminal {
            Some(Terminal::Failed(ref f)) => {
                assert_eq!(f.code.as_deref(), Some("server_error"));
                assert_eq!(f.message, "boom");
            }
            ref other => panic!("{other:?}"),
        }
    }

    #[test]
    fn chain_delta_needs_the_exact_prefix_and_the_models_own_echo() {
        let fp = chain_fingerprint(&body(json!([])));
        let last = LastResponse {
            response_id: "r1".into(),
            fingerprint: fp.clone(),
            full_input: vec![user("hi")],
            text: "Hello".into(),
            call_ids: vec![],
        };
        assert_eq!(
            chain_delta(&last, &fp, &[user("hi"), assistant("Hello"), user("more")]),
            Some(vec![user("more")])
        );
        // The client edited the model's answer: no chain.
        assert_eq!(chain_delta(&last, &fp, &[user("hi"), assistant("Hello!!"), user("more")]), None);
        // An earlier message changed: no chain.
        assert_eq!(chain_delta(&last, &fp, &[user("hey"), assistant("Hello"), user("more")]), None);
        // Other instructions: no chain.
        let mut other = body(json!([]));
        other.insert("instructions".into(), json!("Be verbose."));
        assert_eq!(chain_delta(&last, &chain_fingerprint(&other), &[user("hi"), assistant("Hello"), user("more")]), None);
        // Nothing new after the echo: no chain.
        assert_eq!(chain_delta(&last, &fp, &[user("hi"), assistant("Hello")]), None);
    }

    #[test]
    fn a_ws_error_frame_keeps_status_code_and_retry_hint() {
        let f = failure_from_error_frame(&json!({
            "type": "error", "status": 429,
            "error": {"type": "requests", "code": "rate_limit_exceeded", "message": "Rate limit reached. Please try again in 1.5s."}
        }));
        assert_eq!(f.status, Some(429));
        assert_eq!(f.code.as_deref(), Some("rate_limit_exceeded"));
        assert_eq!(f.retry_after_ms, Some(1500));
        assert!(f.retryable);
        assert_eq!(classify_ws_failure(&f, false, false), FailKind::Final);
    }

    // -- live HTTP SSE ---------------------------------------------------------

    #[tokio::test]
    async fn sse_turn_maps_reasoning_text_and_tool_call_deltas_in_order() {
        let frames = [
            json!({"type":"response.created","response":{"id":"resp_1","model":"gpt-test","status":"in_progress"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}),
            json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"Thinking"}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"Thinking"}],"encrypted_content":"enc"}}),
            json!({"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"delta":"Zażółć "}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"delta":"gęślą"}),
            json!({"type":"response.output_text.done","item_id":"msg_1","output_index":1,"text":"Zażółć gęślą"}),
            json!({"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"city\":"}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"\"Kielce\"}"}),
            json!({"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":2,"arguments":"{\"city\":\"Kielce\"}"}),
            json!({"type":"response.output_item.done","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"Kielce\"}"}}),
            json!({"type":"response.completed","response":{"id":"resp_1","model":"gpt-test","status":"completed","output":[],
                "usage":{"input_tokens":12,"output_tokens":7,"input_tokens_details":{"cached_tokens":8}}}}),
        ];
        let mut payload = String::from(": warm-up\r\n\r\n");
        for f in &frames {
            payload.push_str(&sse_crlf(f));
        }
        let (url, server) = sse_server(payload.into_bytes(), 5).await;
        let (events, sink) = collector();
        let client = reqwest::Client::new();
        let token = CancellationToken::new();
        let s = spec(&url, "ws://127.0.0.1:1/v1/responses", json!([user("weather?")]));
        let end = sse_turn(&client, &s, &token, &sink).await.unwrap();
        assert_eq!(end, TurnEnd::Completed { commit: Some("resp_1".into()) });
        let request = server.await.unwrap();
        assert!(request.contains("\"stream\":true"), "{request}");
        assert!(request.to_ascii_lowercase().contains("authorization: bearer sk-test-0123456789abcdef"));
        let got = events.lock().unwrap().clone();
        let want = vec![
            ResponsesStreamEvent::Created { response_id: Some("resp_1".into()), model: Some("gpt-test".into()), transport: "sse".into() },
            ResponsesStreamEvent::ReasoningDelta { delta: "Thinking".into(), item_id: Some("rs_1".into()), summary: true },
            ResponsesStreamEvent::ReasoningItemDone { item_id: "rs_1".into(), encrypted_content: Some("enc".into()), summary: vec!["Thinking".into()] },
            ResponsesStreamEvent::TextDelta { delta: "Zażółć ".into(), item_id: Some("msg_1".into()) },
            ResponsesStreamEvent::TextDelta { delta: "gęślą".into(), item_id: Some("msg_1".into()) },
            ResponsesStreamEvent::FunctionCallStarted { item_id: Some("fc_1".into()), call_id: "call_1".into(), name: "get_weather".into() },
            ResponsesStreamEvent::FunctionCallArgsDelta { item_id: Some("fc_1".into()), call_id: Some("call_1".into()), delta: "{\"city\":".into() },
            ResponsesStreamEvent::FunctionCallArgsDelta { item_id: Some("fc_1".into()), call_id: Some("call_1".into()), delta: "\"Kielce\"}".into() },
            ResponsesStreamEvent::FunctionCallDone { item_id: Some("fc_1".into()), call_id: "call_1".into(), name: "get_weather".into(), arguments: "{\"city\":\"Kielce\"}".into() },
            ResponsesStreamEvent::Completed {
                response_id: Some("resp_1".into()), model: Some("gpt-test".into()), status: "completed".into(),
                finish_reason: Some("tool_calls".into()), input_tokens: Some(12), output_tokens: Some(7), cached_tokens: Some(8), transport: "sse".into(),
            },
        ];
        assert_eq!(got, want);
    }

    #[tokio::test]
    async fn a_pre_cancelled_token_never_opens_a_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            while let Ok((_sock, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        let registry = crate::cancel_registry::CancelRegistry::new();
        registry.cancel("s-1");
        let (token, _guard) = registry.register("s-1".to_string());
        assert!(token.is_cancelled());
        let (events, sink) = collector();
        let sessions = ResponsesSessionRegistry::new();
        let s = spec(&format!("http://{addr}/v1/responses"), &format!("ws://{addr}/v1/responses"), json!([user("hi")]));
        let client = reqwest::Client::new();
        for transport in [Transport::Sse, Transport::WebSocket, Transport::Auto] {
            let end = run_turn(&client, &sessions, &s, transport, &token, &sink).await.unwrap();
            assert_eq!(end, TurnEnd::Cancelled);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 0);
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelling_mid_stream_closes_the_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut sock).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n").await.unwrap();
            let delta = json!({"type":"response.output_text.delta","item_id":"m","delta":"partial"});
            sock.write_all(sse_crlf(&delta).as_bytes()).await.unwrap();
            sock.flush().await.unwrap();
            // Hold the stream open; the client hanging up ends this read.
            let mut buf = [0u8; 64];
            tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await.ok().and_then(Result::ok)
        });
        let token = CancellationToken::new();
        let cancel = token.clone();
        let sink = move |ev: ResponsesStreamEvent| {
            if matches!(ev, ResponsesStreamEvent::TextDelta { .. }) {
                cancel.cancel();
            }
            true
        };
        let s = spec(&format!("http://{addr}/v1/responses"), "ws://127.0.0.1:1/v1/responses", json!([user("hi")]));
        let client = reqwest::Client::new();
        let end = tokio::time::timeout(Duration::from_secs(5), sse_turn(&client, &s, &token, &sink))
            .await
            .expect("cancel must end the turn")
            .unwrap();
        assert_eq!(end, TurnEnd::Cancelled);
        // The server saw the connection close (read returned 0), not the
        // five second timeout.
        assert_eq!(server.await.unwrap(), Some(0));
    }

    // -- live WebSocket --------------------------------------------------------

    #[derive(Clone)]
    enum Act {
        Send(Value),
        PingAwaitPong,
        Drop,
    }

    #[derive(Default)]
    struct WsLog {
        headers: Vec<Vec<(String, String)>>,
        frames: Vec<Value>,
        pongs: usize,
    }

    type Script = Arc<dyn Fn(usize, &Value) -> Vec<Act> + Send + Sync>;

    async fn ws_mock(script: Script) -> (String, Arc<Mutex<WsLog>>) {
        use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let log = Arc::new(Mutex::new(WsLog::default()));
        let server_log = log.clone();
        tokio::spawn(async move {
            let turn = Arc::new(AtomicUsize::new(0));
            while let Ok((sock, _)) = listener.accept().await {
                let log = server_log.clone();
                let script = script.clone();
                let turn = turn.clone();
                tokio::spawn(async move {
                    let header_log = log.clone();
                    let callback = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                        let headers = req
                            .headers()
                            .iter()
                            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                            .collect();
                        header_log.lock().unwrap().headers.push(headers);
                        Ok(resp)
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(sock, callback).await else {
                        return;
                    };
                    while let Some(Ok(msg)) = ws.next().await {
                        let text = match msg {
                            Message::Text(t) => t,
                            Message::Pong(_) => {
                                log.lock().unwrap().pongs += 1;
                                continue;
                            }
                            _ => continue,
                        };
                        let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                        log.lock().unwrap().frames.push(frame.clone());
                        let n = turn.fetch_add(1, Ordering::SeqCst);
                        for act in script(n, &frame) {
                            match act {
                                Act::Send(v) => {
                                    if ws.send(Message::text(v.to_string())).await.is_err() {
                                        return;
                                    }
                                }
                                Act::PingAwaitPong => {
                                    ws.send(Message::Ping(b"hb".to_vec().into())).await.unwrap();
                                    loop {
                                        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
                                            Ok(Some(Ok(Message::Pong(_)))) => {
                                                log.lock().unwrap().pongs += 1;
                                                break;
                                            }
                                            Ok(Some(Ok(_))) => continue,
                                            _ => return,
                                        }
                                    }
                                }
                                Act::Drop => return,
                            }
                        }
                    }
                });
            }
        });
        (format!("ws://{addr}/v1/responses"), log)
    }

    fn completed(id: &str, text: &str) -> Vec<Act> {
        vec![
            Act::Send(json!({"type":"response.created","response":{"id":id,"model":"gpt-test","status":"in_progress"}})),
            Act::Send(json!({"type":"response.output_text.delta","item_id":format!("msg_{id}"),"output_index":0,"delta":text})),
            Act::Send(json!({"type":"response.completed","response":{"id":id,"model":"gpt-test","status":"completed","usage":{"input_tokens":3,"output_tokens":1}}})),
        ]
    }

    #[tokio::test]
    async fn ws_chains_only_on_clean_completion_and_answers_pings() {
        let script: Script = Arc::new(|n, _frame| match n {
            0 => {
                let mut acts = vec![Act::PingAwaitPong];
                acts.extend(completed("resp_1", "Hello"));
                acts
            }
            1 => completed("resp_2", "Again"),
            2 => vec![
                Act::Send(json!({"type":"response.created","response":{"id":"resp_3","status":"in_progress"}})),
                Act::Send(json!({"type":"response.failed","response":{"id":"resp_3","status":"failed","error":{"code":"invalid_prompt","message":"nope"}}})),
            ],
            _ => completed("resp_4", "Ok"),
        });
        let (ws_url, log) = ws_mock(script).await;
        let http_url = ws_url.replacen("ws://", "http://", 1);
        let registry = ResponsesSessionRegistry::new();
        let token = CancellationToken::new();
        let (events, sink) = collector();

        let a = spec(&http_url, &ws_url, json!([user("hi")]));
        assert_eq!(run_ws(&registry, &a, &token, &sink).await.unwrap(), TurnEnd::Completed { commit: Some("resp_1".into()) });

        let b = spec(&http_url, &ws_url, json!([user("hi"), assistant("Hello"), user("more")]));
        assert_eq!(run_ws(&registry, &b, &token, &sink).await.unwrap(), TurnEnd::Completed { commit: Some("resp_2".into()) });

        let c_input = json!([user("hi"), assistant("Hello"), user("more"), assistant("Again"), user("third")]);
        let c = spec(&http_url, &ws_url, c_input.clone());
        let failed = run_ws(&registry, &c, &token, &sink).await.unwrap_err();
        assert_eq!(failed.kind, FailKind::Final);
        assert_eq!(failed.failure.code.as_deref(), Some("invalid_prompt"));

        let mut d_items = c_input.as_array().unwrap().clone();
        d_items.push(user("again"));
        let d = spec(&http_url, &ws_url, Value::Array(d_items.clone()));
        assert_eq!(run_ws(&registry, &d, &token, &sink).await.unwrap(), TurnEnd::Completed { commit: Some("resp_4".into()) });

        let log = log.lock().unwrap();
        assert_eq!(log.frames.len(), 4);
        for f in &log.frames {
            assert_eq!(f["type"], "response.create");
            assert!(f.get("stream").is_none());
            assert_eq!(f["instructions"], "Be brief.");
        }
        assert!(log.frames[0].get("previous_response_id").is_none());
        assert_eq!(log.frames[1]["previous_response_id"], "resp_1");
        assert_eq!(log.frames[1]["input"], json!([user("more")]));
        assert_eq!(log.frames[2]["previous_response_id"], "resp_2");
        assert_eq!(log.frames[2]["input"], json!([user("third")]));
        // After the failed turn nothing is chained, least of all its id.
        assert!(log.frames[3].get("previous_response_id").is_none());
        assert_eq!(log.frames[3]["input"], Value::Array(d_items));
        // Turns 1-3 shared one socket; the failure dropped it.
        assert_eq!(log.headers.len(), 2);
        let first = &log.headers[0];
        let header = |name: &str| first.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        assert_eq!(header("openai-beta").as_deref(), Some(OPENAI_BETA_WS));
        assert_eq!(header("authorization").as_deref(), Some("Bearer sk-test-0123456789abcdef"));
        assert!(log.pongs >= 1, "the client must answer the server's ping");
        drop(log);
        let texts: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                ResponsesStreamEvent::TextDelta { delta, .. } => Some(delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["Hello", "Again", "Ok"]);
    }

    #[tokio::test]
    async fn a_wrapped_ws_error_frame_surfaces_with_its_status() {
        let script: Script = Arc::new(|_, _| {
            vec![Act::Send(json!({
                "type": "error", "status": 429,
                "error": {"code": "rate_limit_exceeded", "message": "Rate limit reached. Please try again in 2s."}
            }))]
        });
        let (ws_url, _log) = ws_mock(script).await;
        let http_url = ws_url.replacen("ws://", "http://", 1);
        let registry = ResponsesSessionRegistry::new();
        let (_events, sink) = collector();
        let s = spec(&http_url, &ws_url, json!([user("hi")]));
        let f = run_ws(&registry, &s, &CancellationToken::new(), &sink).await.unwrap_err();
        assert_eq!(f.failure.status, Some(429));
        assert_eq!(f.failure.code.as_deref(), Some("rate_limit_exceeded"));
        assert_eq!(f.failure.retry_after_ms, Some(2000));
        assert!(!f.visible);
        assert_eq!(f.kind, FailKind::Final);
    }

    /// Raw server: a WebSocket upgrade gets 426, a POST gets a short SSE
    /// answer. Counts both.
    async fn upgrade_refusing_server() -> (String, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upgrades = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(AtomicUsize::new(0));
        let (u, p) = (upgrades.clone(), posts.clone());
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (u, p) = (u.clone(), p.clone());
                tokio::spawn(async move {
                    let request = read_http_request(&mut sock).await;
                    if request.to_ascii_lowercase().contains("upgrade: websocket") {
                        u.fetch_add(1, Ordering::SeqCst);
                        let _ = sock
                            .write_all(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                    } else {
                        p.fetch_add(1, Ordering::SeqCst);
                        let mut body = String::new();
                        body.push_str(&sse_crlf(&json!({"type":"response.created","response":{"id":"resp_s","model":"m"}})));
                        body.push_str(&sse_crlf(&json!({"type":"response.output_text.delta","item_id":"m1","delta":"via sse"})));
                        body.push_str(&sse_crlf(&json!({"type":"response.completed","response":{"id":"resp_s","model":"m","status":"completed"}})));
                        let _ = sock
                            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}").as_bytes())
                            .await;
                    }
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("127.0.0.1:{}", addr.port()), upgrades, posts)
    }

    #[tokio::test]
    async fn auto_falls_back_to_sse_when_the_upgrade_is_refused_and_remembers_it() {
        let (host, upgrades, posts) = upgrade_refusing_server().await;
        let s = spec(&format!("http://{host}/v1/responses"), &format!("ws://{host}/v1/responses"), json!([user("hi")]));
        let registry = ResponsesSessionRegistry::new();
        let client = reqwest::Client::new();
        let (events, sink) = collector();
        let token = CancellationToken::new();
        let end = run_turn(&client, &registry, &s, Transport::Auto, &token, &sink).await.unwrap();
        assert!(matches!(end, TurnEnd::Completed { .. }));
        assert!(registry.ws_unsupported(&s.endpoint_key));
        assert!(events.lock().unwrap().contains(&ResponsesStreamEvent::Created {
            response_id: Some("resp_s".into()),
            model: Some("m".into()),
            transport: "sse".into()
        }));
        assert_eq!(upgrades.load(Ordering::SeqCst), 1);
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        // The second turn goes straight to SSE.
        run_turn(&client, &registry, &s, Transport::Auto, &token, &sink).await.unwrap();
        assert_eq!(upgrades.load(Ordering::SeqCst), 1);
        assert_eq!(posts.load(Ordering::SeqCst), 2);
        // Forced WebSocket surfaces the refusal instead of falling back.
        let f = run_turn(&client, &registry, &s, Transport::WebSocket, &token, &sink).await.unwrap_err();
        assert_eq!(f.kind, FailKind::Unsupported);
        assert_eq!(f.failure.status, Some(426));
    }

    #[tokio::test]
    async fn no_fallback_once_visible_output_was_sent() {
        let script: Script = Arc::new(|_, _| {
            vec![
                Act::Send(json!({"type":"response.created","response":{"id":"resp_x","status":"in_progress"}})),
                Act::Send(json!({"type":"response.output_text.delta","item_id":"m","delta":"partial"})),
                Act::Drop,
            ]
        });
        let (ws_url, _log) = ws_mock(script).await;
        // The SSE endpoint is a separate listener that only counts.
        let sse_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sse_addr = sse_listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((_sock, _)) = sse_listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        let s = spec(&format!("http://{sse_addr}/v1/responses"), &ws_url, json!([user("hi")]));
        let registry = ResponsesSessionRegistry::new();
        let client = reqwest::Client::new();
        let (events, sink) = collector();
        let f = run_turn(&client, &registry, &s, Transport::Auto, &CancellationToken::new(), &sink)
            .await
            .unwrap_err();
        assert!(f.visible);
        assert_eq!(f.failure.code.as_deref(), Some("stream_broken"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0, "no SSE request after visible output");
        let texts = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, ResponsesStreamEvent::TextDelta { .. }))
            .count();
        assert_eq!(texts, 1, "the partial text was not repeated");
    }

    #[test]
    fn transport_and_idle_settings_parse_like_the_proxy() {
        assert_eq!(Transport::parse(None).unwrap(), Transport::Auto);
        assert_eq!(Transport::parse(Some("WebSocket")).unwrap(), Transport::WebSocket);
        assert_eq!(Transport::parse(Some("sse")).unwrap(), Transport::Sse);
        assert!(Transport::parse(Some("carrier-pigeon")).is_err());
        assert_eq!(idle_window(None), DEFAULT_IDLE);
        assert_eq!(idle_window(Some(0)), FIRST_CHUNK_OFF);
        assert_eq!(idle_window(Some(10)), Duration::from_secs(1));
        assert_eq!(idle_window(Some(u64::MAX)), FIRST_CHUNK_OFF);
    }

    #[test]
    fn events_serialize_with_a_snake_case_kind_tag() {
        let v = serde_json::to_value(ResponsesStreamEvent::FunctionCallArgsDelta {
            item_id: Some("fc".into()),
            call_id: None,
            delta: "{".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "function_call_args_delta");
        assert_eq!(v["item_id"], "fc");
        assert_eq!(serde_json::to_value(ResponsesStreamEvent::Eof {}).unwrap(), json!({"kind": "eof"}));
    }
}
