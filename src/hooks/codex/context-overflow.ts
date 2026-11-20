// ─── A request the server's context could not hold ───
//
// GH #140 (Code Agent, /loop): long runs ended pass after pass on HTTP 400
// "the request exceeds the available context size" and never compacted. LU
// sizes each step against the window it resolved for the model, estimated at
// four characters a token, and the tool catalogue rides on top of that. When
// the server holds less (a model loaded with a smaller context than it was
// trained for, a tokenizer that packs code denser than four characters), every
// step was refused the same way, and the loop fired the same refusal again on
// the next pass.
//
// The refusal names the numbers more often than not. This reads them, and the
// step goes out again with the history cut to a budget that fits, instead of
// ending the pass. The budget is remembered for the model and the window it
// runs with, so the next step and the next pass start inside it.

import { errorText } from '../../types/json-guards'

export interface ContextOverflow {
  /** What the server can hold, when it said so. */
  window?: number
  /** What it counted for the refused request, when it said so. */
  promptTokens?: number
}

// llama.cpp / the built-in engine, LM Studio, vLLM and OpenAI-style servers,
// Anthropic via LU Cloud, and Ollama's own wording, in that order.
const OVERFLOW = /exceed(?:s|ed)? the available context|exceed_context_size|context length of only|context the overflows|maximum context length|context[_ ]length[_ ]exceeded|prompt is too long|input length exceeds the (?:maximum )?context/i

const num = (text: string, re: RegExp): number | undefined => {
  const m = text.match(re)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** The overflow a failed request reports, or null for any other failure. */
export function contextOverflowOf(err: unknown): ContextOverflow | null {
  const text = errorText(err)
  if (!OVERFLOW.test(text)) return null
  return {
    window:
      num(text, /n_ctx[":= ]+(\d+)/) ??
      num(text, /context size \((\d+) tokens\)/i) ??
      num(text, /maximum context length is (\d+)/i) ??
      num(text, /context length of only (\d+)/i) ??
      num(text, /tokens > (\d+)/),
    promptTokens:
      num(text, /n_prompt_tokens[":= ]+(\d+)/) ??
      num(text, /request \((\d+) tokens\)/i) ??
      num(text, /(?:you requested|resulted in) (\d+) tokens/i) ??
      num(text, /too long: (\d+) tokens/i),
  }
}

/** Below this the system prompt alone does not fit; another cut cannot help. */
export const MIN_SEND_WINDOW = 1024

/**
 * The history budget for the retry, strictly below what was just refused, or
 * null when there is nothing left to cut.
 *
 * `sent` is the estimated size of the history that went out, `sentTotal` the
 * same with the tool catalogue. With both numbers from the server the cut is
 * exact up to the estimate (and 15 % room for the answer and for estimates that
 * run short); with only the window it scales our own count; with neither it
 * takes 40 % off and tries again.
 */
export function shrunkSendWindow(sent: number, overflow: ContextOverflow, sentTotal: number): number | null {
  if (!(sent > 0)) return null
  const { window, promptTokens } = overflow
  const raw = window && promptTokens
    ? sent * (window / promptTokens) * 0.85
    : window && sentTotal > 0
      ? sent * Math.min(1, window / sentTotal) * 0.75
      : sent * 0.6
  const next = Math.floor(Math.min(raw, sent * 0.9))
  return next >= MIN_SEND_WINDOW ? next : null
}

/** model + window it runs with → the history budget that fit last time. */
const learned = new Map<string, number>()

const keyOf = (model: string, numCtx: number) => `${model}@${numCtx}`

/** The send window, held under what this model's server showed it can take. */
export function capToLearnedWindow(sendWindow: number, model: string, numCtx: number): number {
  const cap = learned.get(keyOf(model, numCtx))
  return cap && cap < sendWindow ? cap : sendWindow
}

export function learnSendWindow(model: string, numCtx: number, budget: number): void {
  learned.set(keyOf(model, numCtx), budget)
}

/** Test-only. */
export function __resetLearnedWindowsForTests(): void {
  learned.clear()
}
