//! `POST /v1/responses` and `GET /v1/responses` (WebSocket) of the LU local
//! API: the OpenAI Responses API in front of the lanes, which all speak Chat
//! Completions.
//!
//! Every turn is translated, not proxied: the request becomes a
//! `/chat/completions` request to the lane that holds the model (the same
//! resolution, engine load and error codes as every other route, via
//! `local_api::upstream_ziel`), and the lane's answer becomes Responses
//! events. One translator (`ResponsesStreamTranslator`) produces those events
//! for all three outlets, so SSE, the WebSocket and the plain JSON answer can
//! never disagree about what a turn produced:
//!
//!   * `stream: true` → `event: <type>\ndata: <json>\n\n` frames,
//!   * the WebSocket → one text frame per event,
//!   * `stream: false` → the final response object of the same translator,
//!     fed with the lane's whole answer as one synthetic chunk.
//!
//! `previous_response_id` continues a response of this server: the turn's
//! conversation (in Chat Completions form, without the system prompt, which
//! the Responses API never carries over) is kept in `ResponseStore`, in memory
//! and bounded, and is stored BEFORE the final event goes out, so a client
//! that answers the completion at once always finds it.

use std::collections::{BTreeMap, VecDeque};

use axum::body::Body;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxumState;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::local_api::{
    engine_schluessel, fehler, fehler_mit, forward_headers, header_map_to_btree, jetzt_ms,
    koerper_abgelehnt, qualified_id, upstream_ziel, Koerper, Lane, Laufend, LocalApiState,
};
use super::responses::SseLineDecoder;

/// Responses kept for `previous_response_id`. Oldest first out.
const STORE_CAP: usize = 256;

/// Events in flight between the upstream reader and a slow client.
const EVENT_BUFFER: usize = 64;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct StoredResponse {
    pub id: String,
    /// The qualified model id (`ollama/qwen`).
    pub model: String,
    /// History, this turn's input and the assistant's answer, as Chat
    /// Completions messages. System messages from `instructions` are not in
    /// it: they do not carry over to a continuation.
    pub conversation: Vec<Value>,
    pub instructions: Option<String>,
}

/// The bounded memory of `previous_response_id`.
#[derive(Debug, Default)]
pub struct ResponseStore {
    items: VecDeque<StoredResponse>,
}

impl ResponseStore {
    pub fn get(&self, id: &str) -> Option<&StoredResponse> {
        self.items.iter().find(|r| r.id == id)
    }

    pub fn put(&mut self, response: StoredResponse) {
        self.items.retain(|r| r.id != response.id);
        while self.items.len() >= STORE_CAP {
            self.items.pop_front();
        }
        self.items.push_back(response);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }
}

// ---------------------------------------------------------------------------
// Request translation (Responses → Chat Completions)
// ---------------------------------------------------------------------------

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn neue_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

fn part_texts(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|p| str_of(p, "text").or(str_of(p, "refusal")))
        .collect::<Vec<_>>()
        .join("")
}

/// A message's `content` in Chat Completions form. Text-only content becomes
/// a plain string (what every local chat template understands); a user turn
/// with images keeps its parts.
fn inhalt_fuer_chat(content: &Value, role: &str) -> Result<Value, String> {
    match content {
        Value::String(s) => Ok(json!(s)),
        Value::Null => Ok(json!("")),
        Value::Array(parts) => {
            let mut chat_parts = Vec::new();
            let mut nur_text = true;
            for p in parts {
                match str_of(p, "type").unwrap_or("") {
                    "input_text" | "output_text" | "text" | "summary_text" => {
                        chat_parts
                            .push(json!({"type": "text", "text": str_of(p, "text").unwrap_or("")}));
                    }
                    "refusal" => {
                        chat_parts.push(
                            json!({"type": "text", "text": str_of(p, "refusal").unwrap_or("")}),
                        );
                    }
                    "input_image" | "image_url" => {
                        let url = match p.get("image_url") {
                            Some(Value::String(u)) => u.clone(),
                            Some(Value::Object(o)) => o
                                .get("url")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            _ => String::new(),
                        };
                        if url.is_empty() {
                            return Err("An input_image part needs an image_url (an http(s) or a data: URL). File ids are not supported by the LU local API.".to_string());
                        }
                        let mut image = json!({"url": url});
                        if let Some(detail) = str_of(p, "detail") {
                            image["detail"] = json!(detail);
                        }
                        chat_parts.push(json!({"type": "image_url", "image_url": image}));
                        nur_text = false;
                    }
                    other => {
                        return Err(format!(
                            "Content parts of type '{other}' are not supported by the LU local API."
                        ))
                    }
                }
            }
            if nur_text || role != "user" {
                Ok(json!(part_texts(&chat_parts)))
            } else {
                Ok(Value::Array(chat_parts))
            }
        }
        _ => Err("Message content must be a string or an array of content parts.".to_string()),
    }
}

/// `input` as Chat Completions messages.
///
/// `function_call` items fold into the assistant message before them (one
/// assistant turn, its text and its tool calls), `function_call_output`
/// becomes a `tool` message, and the readable text of a `reasoning` item goes
/// to the next assistant message as `reasoning_content`. An encrypted
/// reasoning blob of another server means nothing to a local engine and is
/// left out.
pub(crate) fn eingabe_fuer_chat(input: &Value) -> Result<Vec<Value>, String> {
    let items = match input {
        Value::String(s) => return Ok(vec![json!({"role": "user", "content": s})]),
        Value::Array(a) => a,
        _ => return Err("`input` must be a string or an array of input items.".to_string()),
    };
    let mut msgs: Vec<Value> = Vec::new();
    let mut denken = String::new();
    for item in items {
        let ty = str_of(item, "type");
        let ist_nachricht = ty == Some("message") || (ty.is_none() && item.get("role").is_some());
        if ist_nachricht {
            let role = match str_of(item, "role") {
                Some("developer") | Some("system") => "system",
                Some("assistant") => "assistant",
                Some("user") | None => "user",
                Some(other) => {
                    return Err(format!(
                        "Unknown role '{other}'. Use user, assistant, system or developer."
                    ))
                }
            };
            let content = inhalt_fuer_chat(item.get("content").unwrap_or(&Value::Null), role)?;
            let mut m = json!({"role": role, "content": content});
            if role == "assistant" && !denken.is_empty() {
                m["reasoning_content"] = json!(std::mem::take(&mut denken));
            }
            msgs.push(m);
            continue;
        }
        match ty {
            Some("function_call") => {
                let call_id = str_of(item, "call_id")
                    .or(str_of(item, "id"))
                    .unwrap_or("call_0");
                let name = str_of(item, "name").unwrap_or("");
                let args = match item.get("arguments") {
                    Some(Value::String(s)) => s.clone(),
                    Some(v) if !v.is_null() => v.to_string(),
                    _ => "{}".to_string(),
                };
                let call = json!({"id": call_id, "type": "function", "function": {"name": name, "arguments": args}});
                match msgs.last_mut().filter(|m| m["role"] == "assistant") {
                    Some(last) => match last.get_mut("tool_calls").and_then(Value::as_array_mut) {
                        Some(calls) => calls.push(call),
                        None => last["tool_calls"] = json!([call]),
                    },
                    None => {
                        let mut m = json!({"role": "assistant", "content": Value::Null, "tool_calls": [call]});
                        if !denken.is_empty() {
                            m["reasoning_content"] = json!(std::mem::take(&mut denken));
                        }
                        msgs.push(m);
                    }
                }
            }
            Some("function_call_output") => {
                let call_id = str_of(item, "call_id").unwrap_or("call_0");
                let output = match item.get("output") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(parts)) => part_texts(parts),
                    Some(v) if !v.is_null() => v.to_string(),
                    _ => String::new(),
                };
                msgs.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
            }
            Some("reasoning") => {
                let mut texte: Vec<String> = Vec::new();
                for key in ["summary", "content"] {
                    if let Some(parts) = item.get(key).and_then(Value::as_array) {
                        texte.extend(
                            parts
                                .iter()
                                .filter_map(|p| str_of(p, "text"))
                                .filter(|t| !t.is_empty())
                                .map(str::to_string),
                        );
                    }
                }
                let text = texte.join("\n\n");
                if !text.is_empty() {
                    if !denken.is_empty() {
                        denken.push_str("\n\n");
                    }
                    denken.push_str(&text);
                }
            }
            Some(other) => {
                return Err(format!(
                    "Input items of type '{other}' are not supported by the LU local API."
                ))
            }
            None => return Err("An input item needs a `type` or a `role`.".to_string()),
        }
    }
    Ok(msgs)
}

/// One system message at the front: `instructions` first, then the system and
/// developer messages of the conversation, duplicates once. Local chat
/// templates (Jinja) often refuse a second system turn or one that is not
/// first.
pub(crate) fn chat_nachrichten(instructions: Option<&str>, conversation: &[Value]) -> Vec<Value> {
    let mut system: Vec<String> = Vec::new();
    if let Some(i) = instructions.filter(|i| !i.trim().is_empty()) {
        system.push(i.to_string());
    }
    let mut rest = Vec::new();
    for m in conversation {
        if m["role"] == "system" {
            if let Some(t) = m["content"].as_str() {
                if !t.trim().is_empty() && !system.iter().any(|s| s == t) {
                    system.push(t.to_string());
                }
            }
        } else {
            rest.push(m.clone());
        }
    }
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(json!({"role": "system", "content": system.join("\n\n")}));
    }
    out.extend(rest);
    out
}

/// Responses tools are flat (`{type, name, parameters}`), Chat Completions
/// nests them under `function`. Built-in tools (web search, file search,
/// computer use) do not exist on a lane and are left out.
fn tools_fuer_chat(tools: &Value) -> Option<Value> {
    let arr = tools.as_array()?;
    let out: Vec<Value> = arr
        .iter()
        .filter_map(|t| {
            if str_of(t, "type") != Some("function") {
                return None;
            }
            if t.get("function").is_some_and(Value::is_object) {
                return Some(t.clone());
            }
            let name = str_of(t, "name")?;
            let mut f = Map::new();
            f.insert("name".to_string(), json!(name));
            for k in ["description", "parameters", "strict"] {
                if let Some(v) = t.get(k).filter(|v| !v.is_null()) {
                    f.insert(k.to_string(), v.clone());
                }
            }
            Some(json!({"type": "function", "function": f}))
        })
        .collect();
    (!out.is_empty()).then_some(Value::Array(out))
}

fn tool_choice_fuer_chat(tc: &Value) -> Option<Value> {
    match tc {
        Value::String(s) if matches!(s.as_str(), "auto" | "none" | "required") => Some(tc.clone()),
        Value::Object(o) if o.get("type").and_then(Value::as_str) == Some("function") => {
            if o.get("function").is_some() {
                return Some(tc.clone());
            }
            let name = o.get("name").and_then(Value::as_str)?;
            Some(json!({"type": "function", "function": {"name": name}}))
        }
        _ => None,
    }
}

fn format_fuer_chat(text: &Value) -> Option<Value> {
    let f = text.get("format")?;
    match str_of(f, "type")? {
        "json_schema" => {
            let mut js = Map::new();
            js.insert(
                "name".to_string(),
                json!(str_of(f, "name").unwrap_or("response")),
            );
            for k in ["schema", "strict", "description"] {
                if let Some(v) = f.get(k).filter(|v| !v.is_null()) {
                    js.insert(k.to_string(), v.clone());
                }
            }
            Some(json!({"type": "json_schema", "json_schema": js}))
        }
        "json_object" => Some(json!({"type": "json_object"})),
        _ => None,
    }
}

/// Fields that go to the lane under the same name.
const DURCHREICHEN: [&str; 13] = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "seed",
    "stop",
    "frequency_penalty",
    "presence_penalty",
    "repeat_penalty",
    "parallel_tool_calls",
    "user",
    "metadata",
    "logit_bias",
];

/// Fields of the request that the response object echoes.
const ECHO: [&str; 12] = [
    "instructions",
    "metadata",
    "temperature",
    "top_p",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "max_output_tokens",
    "previous_response_id",
    "reasoning",
    "text",
    "truncation",
];

/// The lane's request body (without `stream`, which the caller sets).
pub(crate) fn chat_koerper(
    body: &Map<String, Value>,
    nachrichten: Vec<Value>,
    upstream_id: &str,
) -> Map<String, Value> {
    let mut chat = Map::new();
    chat.insert("model".to_string(), json!(upstream_id));
    chat.insert("messages".to_string(), Value::Array(nachrichten));
    for k in DURCHREICHEN {
        if let Some(v) = body.get(k).filter(|v| !v.is_null()) {
            chat.insert(k.to_string(), v.clone());
        }
    }
    if let Some(n) = body.get("max_output_tokens").filter(|v| v.is_u64()) {
        chat.insert("max_tokens".to_string(), n.clone());
    }
    if let Some(effort) = body
        .get("reasoning")
        .and_then(|r| r.get("effort"))
        .filter(|v| v.is_string())
    {
        chat.insert("reasoning_effort".to_string(), effort.clone());
    }
    if let Some(tools) = body.get("tools").and_then(tools_fuer_chat) {
        chat.insert("tools".to_string(), tools);
        if let Some(tc) = body.get("tool_choice").and_then(tool_choice_fuer_chat) {
            chat.insert("tool_choice".to_string(), tc);
        }
    }
    if let Some(rf) = body.get("text").and_then(format_fuer_chat) {
        chat.insert("response_format".to_string(), rf);
    }
    chat
}

// ---------------------------------------------------------------------------
// Answer translation (Chat Completions chunks → Responses events)
// ---------------------------------------------------------------------------

struct OffenesItem {
    id: String,
    index: u64,
    text: String,
}

#[derive(Clone)]
struct OffenerCall {
    chat_index: u64,
    id: String,
    call_id: String,
    name: String,
    args: String,
    index: u64,
    open: bool,
}

/// Chat Completions chunks in, Responses events out, for one turn.
///
/// Items open lazily (a reasoning item when the first reasoning arrives, a
/// message with the first text, a function_call with the first tool call
/// delta) and close when the next kind starts or the turn ends, so the
/// `output_index` order is the order in which the model produced them.
pub(crate) struct ResponsesStreamTranslator {
    id: String,
    model: String,
    created_at: u64,
    echo: Map<String, Value>,
    seq: u64,
    next_index: u64,
    output: Vec<(u64, Value)>,
    reasoning: Option<OffenesItem>,
    message: Option<OffenesItem>,
    calls: Vec<OffenerCall>,
    finish_reason: Option<String>,
    pub(crate) usage: Option<(u64, u64)>,
    cached: Option<u64>,
    text_all: String,
    reasoning_all: String,
    final_response: Option<Value>,
}

impl ResponsesStreamTranslator {
    pub(crate) fn new(id: &str, model: &str, echo: Map<String, Value>) -> Self {
        Self {
            id: id.to_string(),
            model: model.to_string(),
            created_at: jetzt_ms() / 1000,
            echo,
            seq: 0,
            next_index: 0,
            output: Vec::new(),
            reasoning: None,
            message: None,
            calls: Vec::new(),
            finish_reason: None,
            usage: None,
            cached: None,
            text_all: String::new(),
            reasoning_all: String::new(),
            final_response: None,
        }
    }

    fn ev(&mut self, ty: &str, fields: Value) -> Value {
        let mut m = match fields {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        m.insert("type".to_string(), json!(ty));
        m.insert("sequence_number".to_string(), json!(self.seq));
        self.seq += 1;
        Value::Object(m)
    }

    fn usage_json(&self) -> Value {
        match self.usage {
            Some((p, a)) => json!({
                "input_tokens": p,
                "output_tokens": a,
                "total_tokens": p + a,
                "input_tokens_details": {"cached_tokens": self.cached.unwrap_or(0)},
                "output_tokens_details": {"reasoning_tokens": 0},
            }),
            None => Value::Null,
        }
    }

    fn response_object(&self, status: &str) -> Value {
        let mut output = self.output.clone();
        output.sort_by_key(|(index, _)| *index);
        let mut m = Map::new();
        m.insert("id".to_string(), json!(self.id));
        m.insert("object".to_string(), json!("response"));
        m.insert("created_at".to_string(), json!(self.created_at));
        m.insert("status".to_string(), json!(status));
        m.insert("model".to_string(), json!(self.model));
        m.insert(
            "output".to_string(),
            Value::Array(output.into_iter().map(|(_, item)| item).collect()),
        );
        m.insert("output_text".to_string(), json!(self.text_all));
        m.insert("usage".to_string(), self.usage_json());
        m.insert("error".to_string(), Value::Null);
        m.insert("incomplete_details".to_string(), Value::Null);
        for (k, v) in &self.echo {
            m.entry(k.clone()).or_insert_with(|| v.clone());
        }
        Value::Object(m)
    }

    /// `response.created` and `response.in_progress`.
    pub(crate) fn start(&mut self) -> Vec<Value> {
        let r = self.response_object("in_progress");
        let created = self.ev("response.created", json!({"response": r}));
        let progress = self.ev("response.in_progress", json!({"response": r}));
        vec![created, progress]
    }

    fn reasoning_delta(&mut self, delta: &str, out: &mut Vec<Value>) {
        if self.reasoning.is_none() {
            self.close_message(out);
            self.close_calls(out);
            let (id, index) = (neue_id("rs"), self.next_index);
            self.next_index += 1;
            self.reasoning = Some(OffenesItem {
                id: id.clone(),
                index,
                text: String::new(),
            });
            let added = self.ev(
                "response.output_item.added",
                json!({"output_index": index, "item": {"id": id, "type": "reasoning", "summary": []}}),
            );
            out.push(added);
            let part = self.ev(
                "response.reasoning_summary_part.added",
                json!({"item_id": id, "output_index": index, "summary_index": 0, "part": {"type": "summary_text", "text": ""}}),
            );
            out.push(part);
        }
        let (id, index) = match self.reasoning.as_mut() {
            Some(r) => {
                r.text.push_str(delta);
                (r.id.clone(), r.index)
            }
            None => return,
        };
        self.reasoning_all.push_str(delta);
        let ev = self.ev(
            "response.reasoning_summary_text.delta",
            json!({"item_id": id, "output_index": index, "summary_index": 0, "delta": delta}),
        );
        out.push(ev);
    }

    fn close_reasoning(&mut self, out: &mut Vec<Value>) {
        let Some(r) = self.reasoning.take() else {
            return;
        };
        let done = self.ev(
            "response.reasoning_summary_text.done",
            json!({"item_id": r.id, "output_index": r.index, "summary_index": 0, "text": r.text}),
        );
        out.push(done);
        let part = self.ev(
            "response.reasoning_summary_part.done",
            json!({"item_id": r.id, "output_index": r.index, "summary_index": 0, "part": {"type": "summary_text", "text": r.text}}),
        );
        out.push(part);
        let item = json!({"id": r.id, "type": "reasoning", "summary": [{"type": "summary_text", "text": r.text}]});
        let ev = self.ev(
            "response.output_item.done",
            json!({"output_index": r.index, "item": item}),
        );
        out.push(ev);
        self.output.push((r.index, item));
    }

    fn text_delta(&mut self, delta: &str, out: &mut Vec<Value>) {
        if self.message.is_none() {
            self.close_reasoning(out);
            self.close_calls(out);
            let (id, index) = (neue_id("msg"), self.next_index);
            self.next_index += 1;
            self.message = Some(OffenesItem {
                id: id.clone(),
                index,
                text: String::new(),
            });
            let added = self.ev(
                "response.output_item.added",
                json!({"output_index": index, "item": {"id": id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}}),
            );
            out.push(added);
            let part = self.ev(
                "response.content_part.added",
                json!({"item_id": id, "output_index": index, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}),
            );
            out.push(part);
        }
        let (id, index) = match self.message.as_mut() {
            Some(m) => {
                m.text.push_str(delta);
                (m.id.clone(), m.index)
            }
            None => return,
        };
        self.text_all.push_str(delta);
        let ev = self.ev(
            "response.output_text.delta",
            json!({"item_id": id, "output_index": index, "content_index": 0, "delta": delta}),
        );
        out.push(ev);
    }

    fn close_message(&mut self, out: &mut Vec<Value>) {
        let Some(m) = self.message.take() else { return };
        let done = self.ev(
            "response.output_text.done",
            json!({"item_id": m.id, "output_index": m.index, "content_index": 0, "text": m.text}),
        );
        out.push(done);
        let part = self.ev(
            "response.content_part.done",
            json!({"item_id": m.id, "output_index": m.index, "content_index": 0, "part": {"type": "output_text", "text": m.text, "annotations": []}}),
        );
        out.push(part);
        let item = json!({
            "id": m.id, "type": "message", "status": "completed", "role": "assistant",
            "content": [{"type": "output_text", "text": m.text, "annotations": []}]
        });
        let ev = self.ev(
            "response.output_item.done",
            json!({"output_index": m.index, "item": item}),
        );
        out.push(ev);
        self.output.push((m.index, item));
    }

    fn tool_delta(&mut self, tc: &Value, out: &mut Vec<Value>) {
        let chat_index = tc.get("index").and_then(Value::as_u64).unwrap_or(0);
        let func = tc.get("function").cloned().unwrap_or(Value::Null);
        let name = str_of(&func, "name").unwrap_or("").to_string();
        let args = match func.get("arguments") {
            Some(Value::String(s)) => s.clone(),
            Some(v) if !v.is_null() => v.to_string(),
            _ => String::new(),
        };
        let i = match self
            .calls
            .iter()
            .position(|c| c.chat_index == chat_index && c.open)
        {
            Some(i) => i,
            None => {
                self.close_reasoning(out);
                self.close_message(out);
                let call = OffenerCall {
                    chat_index,
                    id: neue_id("fc"),
                    call_id: str_of(tc, "id")
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| neue_id("call")),
                    name: name.clone(),
                    args: String::new(),
                    index: self.next_index,
                    open: true,
                };
                self.next_index += 1;
                let added = self.ev(
                    "response.output_item.added",
                    json!({"output_index": call.index, "item": {
                        "id": call.id, "type": "function_call", "status": "in_progress",
                        "call_id": call.call_id, "name": call.name, "arguments": ""
                    }}),
                );
                out.push(added);
                self.calls.push(call);
                self.calls.len() - 1
            }
        };
        if !name.is_empty() && self.calls[i].name.is_empty() {
            self.calls[i].name = name;
        }
        if !args.is_empty() {
            self.calls[i].args.push_str(&args);
            let (id, index) = (self.calls[i].id.clone(), self.calls[i].index);
            let ev = self.ev(
                "response.function_call_arguments.delta",
                json!({"item_id": id, "output_index": index, "delta": args}),
            );
            out.push(ev);
        }
    }

    fn close_calls(&mut self, out: &mut Vec<Value>) {
        for i in 0..self.calls.len() {
            if !self.calls[i].open {
                continue;
            }
            self.calls[i].open = false;
            let c = self.calls[i].clone();
            let done = self.ev(
                "response.function_call_arguments.done",
                json!({"item_id": c.id, "output_index": c.index, "arguments": c.args}),
            );
            out.push(done);
            let item = json!({
                "id": c.id, "type": "function_call", "status": "completed",
                "call_id": c.call_id, "name": c.name, "arguments": c.args
            });
            let ev = self.ev(
                "response.output_item.done",
                json!({"output_index": c.index, "item": item}),
            );
            out.push(ev);
            self.output.push((c.index, item));
        }
    }

    /// One `chat.completion.chunk` (or the synthetic chunk of a whole answer).
    pub(crate) fn chunk(&mut self, v: &Value) -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            let p = u.get("prompt_tokens").and_then(Value::as_u64);
            let a = u.get("completion_tokens").and_then(Value::as_u64);
            if p.is_some() || a.is_some() {
                self.usage = Some((p.unwrap_or(0), a.unwrap_or(0)));
            }
            if let Some(c) = u
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(Value::as_u64)
            {
                self.cached = Some(c);
            }
        }
        let Some(choice) = v
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
        else {
            return out;
        };
        if let Some(delta) = choice.get("delta").or(choice.get("message")) {
            let reasoning = str_of(delta, "reasoning_content")
                .or(str_of(delta, "reasoning"))
                .unwrap_or("");
            if !reasoning.is_empty() {
                self.reasoning_delta(reasoning, &mut out);
            }
            let content = str_of(delta, "content").unwrap_or("");
            if !content.is_empty() {
                self.text_delta(content, &mut out);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for (position, tc) in calls.iter().enumerate() {
                    // A whole answer's tool calls carry no `index`.
                    let mut tc = tc.clone();
                    if tc.is_object() && tc.get("index").is_none() {
                        tc["index"] = json!(position);
                    }
                    self.tool_delta(&tc, &mut out);
                }
            }
        }
        if let Some(reason) = str_of(choice, "finish_reason") {
            self.finish_reason = Some(reason.to_string());
        }
        out
    }

    pub(crate) fn has_finish_reason(&self) -> bool {
        self.finish_reason.is_some()
    }

    /// Close every open item and emit the terminal event.
    pub(crate) fn finish(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        self.close_reasoning(&mut out);
        self.close_message(&mut out);
        self.close_calls(&mut out);
        let (status, incomplete) = match self.finish_reason.as_deref() {
            Some("length") => ("incomplete", Some("max_output_tokens")),
            Some("content_filter") => ("incomplete", Some("content_filter")),
            _ => ("completed", None),
        };
        let mut r = self.response_object(status);
        if let Some(reason) = incomplete {
            r["incomplete_details"] = json!({"reason": reason});
        }
        self.final_response = Some(r.clone());
        let ty = if status == "completed" {
            "response.completed"
        } else {
            "response.incomplete"
        };
        let ev = self.ev(ty, json!({"response": r}));
        out.push(ev);
        out
    }

    /// The terminal event of a turn the lane could not finish.
    pub(crate) fn fail(&mut self, message: &str, code: &str) -> Vec<Value> {
        let mut r = self.response_object("failed");
        r["error"] = json!({"code": code, "message": message});
        let ev = self.ev("response.failed", json!({"response": r}));
        vec![ev]
    }

    pub(crate) fn final_response(&self) -> Option<&Value> {
        self.final_response.as_ref()
    }

    /// The answer as the assistant message of the stored conversation.
    pub(crate) fn assistant_message(&self) -> Value {
        let calls: Vec<Value> = self
            .calls
            .iter()
            .map(|c| json!({"id": c.call_id, "type": "function", "function": {"name": c.name, "arguments": c.args}}))
            .collect();
        let content = if self.text_all.is_empty() && !calls.is_empty() {
            Value::Null
        } else {
            json!(self.text_all)
        };
        let mut m = json!({"role": "assistant", "content": content});
        if !self.reasoning_all.is_empty() {
            m["reasoning_content"] = json!(self.reasoning_all);
        }
        if !calls.is_empty() {
            m["tool_calls"] = Value::Array(calls);
        }
        m
    }
}

/// A whole `chat.completion` as one chunk for the translator.
fn als_chunk(chat: &Value) -> Value {
    let choice = chat
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    json!({
        "choices": [{"index": 0, "delta": message, "finish_reason": choice.get("finish_reason").cloned().unwrap_or(Value::Null)}],
        "usage": chat.get("usage").cloned().unwrap_or(Value::Null),
    })
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

/// A request that did not get as far as the lane.
pub(crate) enum Abgelehnt {
    Fehler {
        status: StatusCode,
        message: String,
        param: Option<&'static str>,
        code: &'static str,
    },
    /// An error response that is already built (`upstream_ziel`).
    Antwort(Box<Response>),
}

impl Abgelehnt {
    fn into_response(self) -> Response {
        match self {
            Abgelehnt::Fehler {
                status,
                message,
                param,
                code,
            } => fehler_mit(status, "invalid_request_error", &message, param, Some(code)),
            Abgelehnt::Antwort(r) => *r,
        }
    }

    /// The same refusal as a WebSocket error frame.
    async fn into_frame(self) -> Value {
        let resp = self.into_response();
        let status = resp.status().as_u16();
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap_or_default();
        let error = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("error").cloned())
            .unwrap_or_else(|| json!({"type": "api_error", "message": String::from_utf8_lossy(&bytes), "code": Value::Null, "param": Value::Null}));
        json!({"type": "error", "status": status, "error": error})
    }
}

fn fehler_frame(status: u16, code: &str, message: &str) -> Value {
    json!({
        "type": "error",
        "status": status,
        "error": {"type": "invalid_request_error", "code": code, "message": message, "param": Value::Null}
    })
}

pub(crate) struct Vorbereitet {
    id: String,
    qualifiziert: String,
    lane: Lane,
    ziel_url: String,
    chat: Map<String, Value>,
    conversation: Vec<Value>,
    instructions: Option<String>,
    store: bool,
    echo: Map<String, Value>,
}

/// Validation, `previous_response_id`, translation and the lane, before a
/// single byte goes upstream. Every refusal here has its HTTP status.
pub(crate) async fn vorbereiten(
    state: &LocalApiState,
    body: &Map<String, Value>,
) -> Result<Vorbereitet, Abgelehnt> {
    let missing = |param: &'static str| Abgelehnt::Fehler {
        status: StatusCode::BAD_REQUEST,
        message: format!("Missing required parameter: '{param}'."),
        param: Some(param),
        code: "missing_required_parameter",
    };
    let modell = match body.get("model").and_then(Value::as_str) {
        Some(m) if !m.trim().is_empty() => m.to_string(),
        _ => return Err(missing("model")),
    };
    let input = match body.get("input") {
        Some(Value::String(s)) if !s.is_empty() => body["input"].clone(),
        Some(Value::Array(a)) if !a.is_empty() => body["input"].clone(),
        Some(Value::String(_)) | Some(Value::Array(_)) | Some(Value::Null) | None => {
            return Err(missing("input"))
        }
        Some(_) => {
            return Err(Abgelehnt::Fehler {
                status: StatusCode::BAD_REQUEST,
                message: "`input` must be a string or an array of input items.".to_string(),
                param: Some("input"),
                code: "invalid_value",
            })
        }
    };
    let mut conversation = match body.get("previous_response_id").and_then(Value::as_str) {
        Some(prev) => match state.response_store.read().await.get(prev) {
            Some(stored) => {
                tracing::debug!(
                    previous = %stored.id,
                    model = %stored.model,
                    had_instructions = stored.instructions.is_some(),
                    "local API: continuing a stored response"
                );
                stored.conversation.clone()
            }
            None => {
                return Err(Abgelehnt::Fehler {
                    status: StatusCode::NOT_FOUND,
                    message: format!(
                        "Previous response with id '{prev}' not found. This server keeps the last {STORE_CAP} responses in memory until the API stops, and none with `store: false`."
                    ),
                    param: Some("previous_response_id"),
                    code: "previous_response_not_found",
                })
            }
        },
        None => Vec::new(),
    };
    let neu = eingabe_fuer_chat(&input).map_err(|message| Abgelehnt::Fehler {
        status: StatusCode::BAD_REQUEST,
        message,
        param: Some("input"),
        code: "invalid_value",
    })?;
    conversation.extend(neu);
    let ziel = upstream_ziel(state, &modell, "/chat/completions")
        .await
        .map_err(Abgelehnt::Antwort)?;
    let instructions = body
        .get("instructions")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let chat = chat_koerper(
        body,
        chat_nachrichten(instructions.as_deref(), &conversation),
        &ziel.upstream_id,
    );
    let store = body.get("store").and_then(Value::as_bool).unwrap_or(true);
    let mut echo = Map::new();
    for k in ECHO {
        if let Some(v) = body.get(k) {
            echo.insert(k.to_string(), v.clone());
        }
    }
    echo.insert("store".to_string(), json!(store));
    Ok(Vorbereitet {
        id: neue_id("resp"),
        qualifiziert: qualified_id(ziel.lane, &ziel.upstream_id),
        lane: ziel.lane,
        ziel_url: format!("{}/chat/completions", ziel.base),
        chat,
        conversation,
        instructions,
        store,
        echo,
    })
}

/// The caller's headers for the lane: the local API's own filter, plus what
/// belongs to this hop only (the WebSocket upgrade, content negotiation that
/// reqwest does itself).
fn upstream_kopf(headers: &HeaderMap) -> BTreeMap<String, String> {
    forward_headers(&header_map_to_btree(headers))
        .into_iter()
        .filter(|(k, _)| {
            !k.starts_with("sec-websocket-")
                && !matches!(
                    k.as_str(),
                    "upgrade"
                        | "accept"
                        | "accept-encoding"
                        | "content-type"
                        | "origin"
                        | "openai-beta"
                )
        })
        .collect()
}

fn upstream_anfrage(
    state: &LocalApiState,
    v: &Vorbereitet,
    kopf: &BTreeMap<String, String>,
    stream: bool,
) -> reqwest::RequestBuilder {
    let mut body = v.chat.clone();
    body.insert("stream".to_string(), json!(stream));
    if stream {
        body.insert("stream_options".to_string(), json!({"include_usage": true}));
    }
    let mut req = state.http.post(&v.ziel_url);
    for (k, val) in kopf {
        if let (Ok(name), Ok(value)) =
            (HeaderName::try_from(k.as_str()), HeaderValue::from_str(val))
        {
            req = req.header(name, value);
        }
    }
    // The LU Engine wants its key (engine_key.rs), and only on loopback.
    if let Some(s) = engine_schluessel(v.lane, &v.ziel_url) {
        req = req.header(header::AUTHORIZATION, s);
    }
    req.json(&Value::Object(body))
}

/// The lane's error text, from its JSON error or its raw body.
fn upstream_fehlertext(status: u16, text: &str) -> String {
    let parsed = serde_json::from_str::<Value>(text).ok();
    let message = parsed.as_ref().and_then(|v| {
        v.get("error")
            .and_then(|e| e.get("message").and_then(Value::as_str).or(e.as_str()))
            .or(v.get("message").and_then(Value::as_str))
            .map(str::to_string)
    });
    match message {
        Some(m) if !m.trim().is_empty() => m,
        _ => {
            let t = text.trim();
            if t.is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {}", t.chars().take(300).collect::<String>())
            }
        }
    }
}

async fn speichern(state: &LocalApiState, v: &Vorbereitet, tr: &ResponsesStreamTranslator) {
    if !v.store {
        return;
    }
    let mut conversation = v.conversation.clone();
    conversation.push(tr.assistant_message());
    state.response_store.write().await.put(StoredResponse {
        id: v.id.clone(),
        model: v.qualifiziert.clone(),
        conversation,
        instructions: v.instructions.clone(),
    });
}

/// The streaming turn: events into `tx` until the lane is done, the lane
/// fails, or the receiver is gone (then the lane request is dropped, which
/// stops the generation).
async fn strom_zug(
    state: LocalApiState,
    v: Vorbereitet,
    kopf: BTreeMap<String, String>,
    tx: mpsc::Sender<Value>,
    waechter: Laufend,
) {
    let _waechter = waechter;
    let mut tr = ResponsesStreamTranslator::new(&v.id, &v.qualifiziert, v.echo.clone());
    for ev in tr.start() {
        if tx.send(ev).await.is_err() {
            return;
        }
    }
    let label = v.lane.label();
    let fail = |tr: &mut ResponsesStreamTranslator, message: String| {
        state.nutzung.fehler();
        tr.fail(&message, "upstream_error")
    };
    let antwort = tokio::select! {
        _ = tx.closed() => return,
        r = upstream_anfrage(&state, &v, &kopf, true).send() => r,
    };
    let antwort = match antwort {
        Ok(r) => r,
        Err(e) => {
            let events = fail(
                &mut tr,
                format!("{label} did not answer: {}", crate::os_error::english(&e)),
            );
            for ev in events {
                let _ = tx.send(ev).await;
            }
            return;
        }
    };
    let status = antwort.status();
    if !status.is_success() {
        let text = antwort.text().await.unwrap_or_default();
        let events = fail(&mut tr, upstream_fehlertext(status.as_u16(), &text));
        for ev in events {
            let _ = tx.send(ev).await;
        }
        return;
    }
    let mut decoder = SseLineDecoder::default();
    let mut quelle = antwort.bytes_stream();
    let mut fertig = false;
    loop {
        let item = tokio::select! {
            _ = tx.closed() => return,
            item = quelle.next() => item,
        };
        let (frames, ende) = match item {
            None => (decoder.finish(), true),
            Some(Err(e)) => {
                let events = fail(
                    &mut tr,
                    format!(
                        "{label} broke off mid-answer: {}",
                        crate::os_error::english(&e)
                    ),
                );
                for ev in events {
                    let _ = tx.send(ev).await;
                }
                return;
            }
            Some(Ok(bytes)) => (decoder.push(&bytes), false),
        };
        for frame in frames {
            if frame.data.trim() == "[DONE]" {
                fertig = true;
                break;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(&frame.data) else {
                continue;
            };
            if let Some(err) = chunk.get("error") {
                let message = err
                    .get("message")
                    .and_then(Value::as_str)
                    .or(err.as_str())
                    .unwrap_or("the model server reported an error")
                    .to_string();
                let events = fail(&mut tr, format!("{label}: {message}"));
                for ev in events {
                    let _ = tx.send(ev).await;
                }
                return;
            }
            for ev in tr.chunk(&chunk) {
                if tx.send(ev).await.is_err() {
                    return;
                }
            }
        }
        if fertig {
            break;
        }
        if ende {
            if tr.has_finish_reason() {
                break;
            }
            let events = fail(
                &mut tr,
                format!("{label} closed the stream before the answer was finished."),
            );
            for ev in events {
                let _ = tx.send(ev).await;
            }
            return;
        }
    }
    let events = tr.finish();
    state.nutzung.zahlen(tr.usage);
    // Stored before the final event leaves: a client that continues the
    // moment it sees `response.completed` must find this response.
    speichern(&state, &v, &tr).await;
    for ev in events {
        if tx.send(ev).await.is_err() {
            return;
        }
    }
}

/// `stream: false`: the lane's whole answer through the same translator.
async fn json_zug(
    state: LocalApiState,
    v: Vorbereitet,
    kopf: BTreeMap<String, String>,
    waechter: Laufend,
) -> Response {
    let label = v.lane.label();
    let antwort = match upstream_anfrage(&state, &v, &kopf, false).send().await {
        Ok(r) => r,
        Err(e) => {
            state.nutzung.fehler();
            return fehler(
                StatusCode::BAD_GATEWAY,
                "api_error",
                &format!("{label} did not answer: {}", crate::os_error::english(&e)),
            );
        }
    };
    let status = antwort.status();
    let bytes = match antwort.bytes().await {
        Ok(b) => b,
        Err(e) => {
            state.nutzung.fehler();
            return fehler(
                StatusCode::BAD_GATEWAY,
                "api_error",
                &format!(
                    "{label} broke off mid-answer: {}",
                    crate::os_error::english(&e)
                ),
            );
        }
    };
    if !status.is_success() {
        state.nutzung.fehler();
        let text = String::from_utf8_lossy(&bytes);
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return fehler_mit(
            code,
            "api_error",
            &upstream_fehlertext(status.as_u16(), &text),
            None,
            Some("upstream_error"),
        );
    }
    let chat: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            state.nutzung.fehler();
            return fehler_mit(
                StatusCode::BAD_GATEWAY,
                "api_error",
                &format!("{label} answered with something that is not JSON."),
                None,
                Some("upstream_error"),
            );
        }
    };
    let mut tr = ResponsesStreamTranslator::new(&v.id, &v.qualifiziert, v.echo.clone());
    tr.start();
    tr.chunk(&als_chunk(&chat));
    tr.finish();
    state.nutzung.zahlen(tr.usage);
    speichern(&state, &v, &tr).await;
    drop(waechter);
    match tr.final_response() {
        Some(r) => Json(r.clone()).into_response(),
        None => fehler(
            StatusCode::INTERNAL_SERVER_ERROR,
            "api_error",
            "Could not build the response.",
        ),
    }
}

fn sse_bytes(ev: &Value) -> axum::body::Bytes {
    let ty = ev.get("type").and_then(Value::as_str).unwrap_or("message");
    axum::body::Bytes::from(format!("event: {ty}\ndata: {ev}\n\n"))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// `POST /v1/responses`.
pub async fn handle_responses_post(
    AxumState(state): AxumState<LocalApiState>,
    headers: HeaderMap,
    body: Koerper,
) -> Response {
    let bytes = match body {
        Ok(b) => b,
        Err(e) => return koerper_abgelehnt(e),
    };
    let json: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            return fehler_mit(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &format!("Body is not JSON: {}", e),
                None,
                Some("invalid_body"),
            )
        }
    };
    let Some(body) = json.as_object() else {
        return fehler_mit(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "Body must be a JSON object.",
            None,
            Some("invalid_body"),
        );
    };
    let modell = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let waechter = state.nutzung.beginn(&modell);
    let v = match vorbereiten(&state, body).await {
        Ok(v) => v,
        Err(abgelehnt) => {
            state.nutzung.fehler();
            return abgelehnt.into_response();
        }
    };
    let kopf = upstream_kopf(&headers);
    if !body.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        return json_zug(state, v, kopf, waechter).await;
    }
    let (tx, rx) = mpsc::channel::<Value>(EVENT_BUFFER);
    tokio::spawn(strom_zug(state, v, kopf, tx, waechter));
    // The client hanging up drops this stream and `rx` with it; `tx.closed()`
    // then ends the turn and drops the lane request.
    let strom = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|ev| (Ok::<_, std::io::Error>(sse_bytes(&ev)), rx))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(strom))
        .unwrap_or_else(|_| {
            fehler(
                StatusCode::INTERNAL_SERVER_ERROR,
                "api_error",
                "Could not build the response.",
            )
        })
}

/// `GET /v1/responses`: the WebSocket of the Responses API.
pub async fn handle_responses_ws(
    AxumState(state): AxumState<LocalApiState>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let ws = match ws {
        Ok(ws) => ws,
        Err(_) => {
            return fehler_mit(
                StatusCode::UPGRADE_REQUIRED,
                "invalid_request_error",
                "GET /v1/responses is the WebSocket of the Responses API. Open it with a WebSocket upgrade, or send POST /v1/responses for HTTP.",
                None,
                Some("upgrade_required"),
            )
        }
    };
    let kopf = upstream_kopf(&headers);
    ws.on_upgrade(move |socket| ws_sitzung(state, socket, kopf))
}

/// A client frame as a request body, or the error frame that answers it.
/// Takes `{"type":"response.create", model, input, …}` and the nested
/// `{"type":"response.create","response":{model, input, …}}`.
pub(crate) fn frame_lesen(text: &str) -> Result<Map<String, Value>, Value> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| fehler_frame(400, "invalid_frame", &format!("The frame is not JSON: {e}")))?;
    let Value::Object(mut frame) = v else {
        return Err(fehler_frame(
            400,
            "invalid_frame",
            "A frame must be a JSON object.",
        ));
    };
    match frame.remove("type").as_ref().and_then(Value::as_str) {
        Some("response.create") => {}
        Some(other) => {
            return Err(fehler_frame(
                400,
                "invalid_frame",
                &format!(
                    "Unknown frame type '{other}'. Send {{\"type\":\"response.create\", ...}}."
                ),
            ))
        }
        None => {
            return Err(fehler_frame(
                400,
                "invalid_frame",
                "A frame needs \"type\": \"response.create\".",
            ))
        }
    }
    if let Some(Value::Object(inner)) = frame.remove("response") {
        for (k, v) in inner {
            frame.insert(k, v);
        }
    }
    // The socket always streams.
    frame.remove("stream");
    Ok(frame)
}

async fn ws_zug(
    state: LocalApiState,
    body: Map<String, Value>,
    kopf: BTreeMap<String, String>,
    tx: mpsc::Sender<Value>,
) {
    let modell = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let waechter = state.nutzung.beginn(&modell);
    match vorbereiten(&state, &body).await {
        Ok(v) => strom_zug(state, v, kopf, tx, waechter).await,
        Err(abgelehnt) => {
            state.nutzung.fehler();
            let _ = tx.send(abgelehnt.into_frame().await).await;
        }
    }
}

/// One socket: frames are turns, one at a time, in the order they came. A
/// frame that arrives while a turn runs waits for it. The client going away
/// aborts the running turn, which drops the lane request.
async fn ws_sitzung(state: LocalApiState, socket: WebSocket, kopf: BTreeMap<String, String>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(EVENT_BUFFER);
    let schreiber = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if sink
                .send(WsMessage::Text(ev.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let mut warteschlange: VecDeque<Map<String, Value>> = VecDeque::new();
    let mut laufend: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        if laufend.is_none() {
            if let Some(body) = warteschlange.pop_front() {
                laufend = Some(tokio::spawn(ws_zug(
                    state.clone(),
                    body,
                    kopf.clone(),
                    tx.clone(),
                )));
            }
        }
        tokio::select! {
            msg = stream.next() => match msg {
                None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => break,
                Some(Ok(WsMessage::Text(text))) => match frame_lesen(text.as_str()) {
                    Ok(body) => warteschlange.push_back(body),
                    Err(frame) => {
                        if tx.send(frame).await.is_err() {
                            break;
                        }
                    }
                },
                Some(Ok(WsMessage::Binary(_))) => {
                    let frame = fehler_frame(400, "invalid_frame", "Binary frames are not supported. Send JSON text frames.");
                    if tx.send(frame).await.is_err() {
                        break;
                    }
                }
                // Ping is answered by the socket itself; Pong needs nothing.
                Some(Ok(_)) => {}
            },
            _ = async { if let Some(t) = laufend.as_mut() { let _ = t.await; } }, if laufend.is_some() => {
                laufend = None;
            }
        }
    }
    if let Some(t) = laufend.take() {
        t.abort();
    }
    drop(tx);
    let _ = schreiber.await;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::local_api::{build_local_api_router, LocalApiConfig, Nutzung, Upstream};
    use axum::routing::{get, post};
    use axum::Router;
    use std::sync::{Arc, Mutex};
    use tokio::sync::RwLock;
    use tokio_tungstenite::tungstenite;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    const TOKEN: &str = "t0k-responses";

    type Seen = Arc<Mutex<Vec<Value>>>;

    const SSE: &str = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Kielce\\\"}\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4}}\n\n",
        "data: [DONE]\n\n",
    );

    async fn mock_models() -> Json<Value> {
        Json(json!({"object": "list", "data": [{"id": "qwen", "object": "model"}]}))
    }

    async fn mock_chat(AxumState(seen): AxumState<Seen>, Json(body): Json<Value>) -> Response {
        seen.lock().unwrap().push(body.clone());
        if body["stream"] == true {
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(SSE))
                .unwrap()
        } else {
            Json(json!({
                "id": "chatcmpl-1", "object": "chat.completion",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": "Hello",
                    "tool_calls": [{"id": "call_a", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Kielce\"}"}}]
                }}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 4}
            }))
            .into_response()
        }
    }

    /// A Chat Completions lane on 127.0.0.1 and the local API in front of it.
    async fn server() -> (std::net::SocketAddr, Seen, LocalApiState) {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let lane = Router::new()
            .route("/v1/models", get(mock_models))
            .route("/v1/chat/completions", post(mock_chat))
            .with_state(seen.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let lane_addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(l, lane).await;
        });
        let state = LocalApiState {
            cfg: Arc::new(RwLock::new(LocalApiConfig {
                port: 0,
                lan: false,
                token: TOKEN.into(),
                upstreams: vec![Upstream {
                    lane_prefix: "ollama".into(),
                    base: format!("http://{lane_addr}/v1"),
                }],
                cors_origins: Vec::new(),
            })),
            http: reqwest::Client::new(),
            nutzung: Arc::new(Nutzung::neu()),
            live: None,
            engine: None,
            lade_schloss: Default::default(),
            response_store: Default::default(),
        };
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = l.local_addr().unwrap();
        let router = build_local_api_router(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(l, router).await;
        });
        (api, seen, state)
    }

    fn sse_events(text: &str) -> Vec<Value> {
        let mut decoder = SseLineDecoder::default();
        let mut frames = decoder.push(text.as_bytes());
        frames.extend(decoder.finish());
        frames
            .into_iter()
            .map(|f| serde_json::from_str(&f.data).unwrap())
            .collect()
    }

    fn types(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .map(|e| e["type"].as_str().unwrap().to_string())
            .collect()
    }

    // -- translation, pure ----------------------------------------------------

    #[test]
    fn input_items_become_chat_messages() {
        let msgs = eingabe_fuer_chat(&json!([
            {"role": "developer", "content": "Be brief."},
            {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "What is this?"},
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
            ]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Looking."}], "encrypted_content": "opaque"},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "A cat."}]},
            {"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{\"a\":1}"},
            {"type": "function_call_output", "call_id": "c1", "output": "ok"}
        ]))
        .unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0], json!({"role": "system", "content": "Be brief."}));
        assert_eq!(
            msgs[1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(msgs[2]["content"], "A cat.");
        assert_eq!(msgs[2]["reasoning_content"], "Looking.");
        assert_eq!(msgs[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(
            msgs[3],
            json!({"role": "tool", "tool_call_id": "c1", "content": "ok"})
        );
        assert!(eingabe_fuer_chat(&json!([{"type": "web_search_call"}])).is_err());
    }

    #[test]
    fn one_system_message_at_the_front_and_flat_tools_nested() {
        let conv = vec![
            json!({"role": "user", "content": "hi"}),
            json!({"role": "system", "content": "Speak Polish."}),
        ];
        let msgs = chat_nachrichten(Some("Be brief."), &conv);
        assert_eq!(
            msgs[0],
            json!({"role": "system", "content": "Be brief.\n\nSpeak Polish."})
        );
        assert_eq!(msgs.len(), 2);
        let body = match json!({
            "model": "qwen", "max_output_tokens": 50, "reasoning": {"effort": "low"}, "temperature": 0.2, "store": false,
            "tools": [{"type": "function", "name": "f", "parameters": {"type": "object"}}, {"type": "web_search"}],
            "tool_choice": {"type": "function", "name": "f"},
            "text": {"format": {"type": "json_schema", "name": "answer", "schema": {"type": "object"}}}
        }) {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        let chat = chat_koerper(&body, msgs, "qwen:7b");
        assert_eq!(chat["model"], "qwen:7b");
        assert_eq!(chat["max_tokens"], 50);
        assert_eq!(chat["reasoning_effort"], "low");
        assert_eq!(chat["temperature"], 0.2);
        assert_eq!(
            chat["tools"],
            json!([{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}])
        );
        assert_eq!(
            chat["tool_choice"],
            json!({"type": "function", "function": {"name": "f"}})
        );
        assert_eq!(chat["response_format"]["json_schema"]["name"], "answer");
        assert!(
            chat.get("store").is_none()
                && chat.get("input").is_none()
                && chat.get("instructions").is_none()
        );
    }

    #[test]
    fn frames_top_level_and_nested_are_read_and_bad_ones_answered() {
        let a =
            frame_lesen(r#"{"type":"response.create","model":"qwen","input":"hi","stream":true}"#)
                .unwrap();
        assert_eq!(a["model"], "qwen");
        assert!(a.get("stream").is_none());
        let b =
            frame_lesen(r#"{"type":"response.create","response":{"model":"qwen","input":"hi"}}"#)
                .unwrap();
        assert_eq!(b["input"], "hi");
        let e = frame_lesen("not json").unwrap_err();
        assert_eq!(e["type"], "error");
        assert_eq!(e["status"], 400);
        assert_eq!(e["error"]["code"], "invalid_frame");
        assert!(frame_lesen(r#"{"type":"session.update"}"#).is_err());
    }

    #[test]
    fn the_store_is_bounded() {
        let mut store = ResponseStore::default();
        for i in 0..(STORE_CAP + 10) {
            store.put(StoredResponse {
                id: format!("resp_{i}"),
                model: "m".into(),
                conversation: vec![],
                instructions: None,
            });
        }
        assert_eq!(store.len(), STORE_CAP);
        assert!(store.get("resp_0").is_none());
        assert!(store.get(&format!("resp_{}", STORE_CAP + 9)).is_some());
    }

    // -- HTTP -----------------------------------------------------------------

    #[tokio::test]
    async fn post_without_stream_answers_one_response_object_and_stores_it() {
        let (api, seen, state) = server().await;
        let c = reqwest::Client::new();
        let r = c
            .post(format!("http://{api}/v1/responses"))
            .bearer_auth(TOKEN)
            .json(&json!({
                "model": "qwen", "input": "hi", "instructions": "Be brief.", "max_output_tokens": 50,
                "tools": [{"type": "function", "name": "get_weather", "parameters": {"type": "object"}}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["object"], "response");
        assert_eq!(v["status"], "completed");
        assert_eq!(v["model"], "ollama/qwen");
        assert_eq!(v["output_text"], "Hello");
        assert!(v["id"].as_str().unwrap().starts_with("resp_"));
        assert_eq!(v["usage"]["input_tokens"], 11);
        assert_eq!(v["usage"]["output_tokens"], 4);
        assert_eq!(v["usage"]["total_tokens"], 15);
        let call = v["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["type"] == "function_call")
            .unwrap()
            .clone();
        assert_eq!(call["call_id"], "call_a");
        assert_eq!(call["name"], "get_weather");
        assert_eq!(call["arguments"], "{\"city\":\"Kielce\"}");
        assert_eq!(v["instructions"], "Be brief.");

        let up = seen.lock().unwrap()[0].clone();
        assert_eq!(up["model"], "qwen");
        assert_eq!(up["stream"], false);
        assert_eq!(up["max_tokens"], 50);
        assert_eq!(
            up["messages"][0],
            json!({"role": "system", "content": "Be brief."})
        );
        assert_eq!(up["messages"][1], json!({"role": "user", "content": "hi"}));
        assert_eq!(up["tools"][0]["function"]["name"], "get_weather");
        assert!(state
            .response_store
            .read()
            .await
            .get(v["id"].as_str().unwrap())
            .is_some());
    }

    #[tokio::test]
    async fn post_stream_chains_with_previous_response_id_and_refuses_what_it_must() {
        let (api, seen, _state) = server().await;
        let c = reqwest::Client::new();
        let url = format!("http://{api}/v1/responses");
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"model": "ollama/qwen", "stream": true, "input": [{"role": "user", "content": "weather?"}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert!(r
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("text/event-stream")));
        let events = sse_events(&r.text().await.unwrap());
        let t = types(&events);
        assert_eq!(&t[..2], &["response.created", "response.in_progress"]);
        for want in [
            "response.reasoning_summary_text.delta",
            "response.output_text.delta",
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
        ] {
            assert!(t.contains(&want.to_string()), "{want} missing in {t:?}");
        }
        assert_eq!(t.last().unwrap(), "response.completed");
        let seqs: Vec<u64> = events
            .iter()
            .map(|e| e["sequence_number"].as_u64().unwrap())
            .collect();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
        let done = &events.last().unwrap()["response"];
        assert_eq!(done["output_text"], "Hello");
        assert_eq!(done["usage"]["input_tokens"], 11);
        let first_id = done["id"].as_str().unwrap().to_string();
        assert_eq!(
            seen.lock().unwrap()[0]["stream_options"]["include_usage"],
            true
        );

        // Turn two continues turn one: the lane gets the whole conversation.
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({
                "model": "qwen", "stream": true, "previous_response_id": first_id,
                "input": [{"type": "function_call_output", "call_id": "call_a", "output": "sunny"}]
            }))
            .send()
            .await
            .unwrap();
        let events = sse_events(&r.text().await.unwrap());
        assert_eq!(types(&events).last().unwrap(), "response.completed");
        let msgs = seen.lock().unwrap()[1]["messages"].clone();
        assert_eq!(msgs.as_array().unwrap().len(), 3);
        assert_eq!(msgs[0], json!({"role": "user", "content": "weather?"}));
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "Hello");
        assert_eq!(msgs[1]["tool_calls"][0]["id"], "call_a");
        assert_eq!(
            msgs[2],
            json!({"role": "tool", "tool_call_id": "call_a", "content": "sunny"})
        );

        // An unknown id.
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"model": "qwen", "previous_response_id": "resp_bogus", "input": "x"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "previous_response_not_found");
        assert_eq!(v["error"]["param"], "previous_response_id");

        // No input.
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"model": "qwen"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "missing_required_parameter");
        assert_eq!(v["error"]["param"], "input");

        // `store: false` keeps nothing to continue from.
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"model": "qwen", "input": "hi", "store": false}))
            .send()
            .await
            .unwrap();
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["store"], false);
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"model": "qwen", "input": "again", "previous_response_id": v["id"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);
    }

    // -- WebSocket ------------------------------------------------------------

    async fn read_until_terminal(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Vec<Value> {
        let mut out = Vec::new();
        loop {
            let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
                .await
                .expect("a frame within 5 s")
                .expect("socket open")
                .expect("no socket error");
            if let tungstenite::Message::Text(t) = msg {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                let ty = v["type"].as_str().unwrap_or("").to_string();
                out.push(v);
                if matches!(
                    ty.as_str(),
                    "response.completed" | "response.incomplete" | "response.failed" | "error"
                ) {
                    return out;
                }
            }
        }
    }

    #[tokio::test]
    async fn the_websocket_needs_the_key_streams_turns_and_answers_bad_frames() {
        let (api, seen, _state) = server().await;
        let url = format!("ws://{api}/v1/responses");

        // Without the key the upgrade is refused by the auth layer.
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Err(tungstenite::Error::Http(resp)) => assert_eq!(resp.status().as_u16(), 401),
            Err(other) => panic!("expected a 401, got {other}"),
            Ok(_) => panic!("an unauthenticated upgrade went through"),
        }

        // A plain GET (no upgrade) is told what this route is.
        let r = reqwest::Client::new()
            .get(format!("http://{api}/v1/responses"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 426);

        let mut req = url.as_str().into_client_request().unwrap();
        req.headers_mut()
            .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

        ws.send(tungstenite::Message::text(
            r#"{"type":"response.create","model":"qwen","input":"weather?"}"#,
        ))
        .await
        .unwrap();
        let events = read_until_terminal(&mut ws).await;
        let t = types(&events);
        assert_eq!(t[0], "response.created");
        assert!(t.contains(&"response.output_text.delta".to_string()));
        assert!(t.contains(&"response.function_call_arguments.delta".to_string()));
        assert_eq!(t.last().unwrap(), "response.completed");
        let first_id = events.last().unwrap()["response"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        // A second turn on the same socket, nested form, continuing the first.
        let frame = json!({"type": "response.create", "response": {
            "model": "qwen", "previous_response_id": first_id,
            "input": [{"type": "function_call_output", "call_id": "call_a", "output": "sunny"}]
        }});
        ws.send(tungstenite::Message::text(frame.to_string()))
            .await
            .unwrap();
        let events = read_until_terminal(&mut ws).await;
        assert_eq!(types(&events).last().unwrap(), "response.completed");
        assert_eq!(
            seen.lock().unwrap()[1]["messages"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(seen.lock().unwrap()[1]["stream"], true);

        // A bad frame gets an error frame, and the socket stays usable.
        ws.send(tungstenite::Message::text("not json"))
            .await
            .unwrap();
        let events = read_until_terminal(&mut ws).await;
        let err = events.last().unwrap();
        assert_eq!(err["type"], "error");
        assert_eq!(err["status"], 400);
        assert_eq!(err["error"]["code"], "invalid_frame");

        // An unknown previous id is an error frame with the HTTP status.
        ws.send(tungstenite::Message::text(
            r#"{"type":"response.create","model":"qwen","input":"x","previous_response_id":"resp_nope"}"#,
        ))
        .await
        .unwrap();
        let events = read_until_terminal(&mut ws).await;
        let err = events.last().unwrap();
        assert_eq!(err["status"], 404);
        assert_eq!(err["error"]["code"], "previous_response_not_found");

        ws.send(tungstenite::Message::text(
            r#"{"type":"response.create","model":"qwen","input":"hi"}"#,
        ))
        .await
        .unwrap();
        assert_eq!(
            types(&read_until_terminal(&mut ws).await).last().unwrap(),
            "response.completed"
        );
        let _ = ws.close(None).await;
    }
}
