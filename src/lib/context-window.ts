/**
 * Effective context-window resolution — single source of truth so the value we
 * SEND to the model (Ollama `num_ctx`) and the value we DISPLAY (TokenCounter
 * denominator) can never disagree (2026-06-05: "muss immer stimmen").
 *
 * Leaf module — imports NOTHING from api/* so it can be used by both the
 * provider layer and the UI without an import cycle.
 *
 * Why a cap and not the model's full trained context:
 *  - Ollama allocates the KV cache for `num_ctx` at load time. A model may
 *    advertise a 128k–256k context, but allocating that much KV cache OOMs
 *    consumer GPUs instantly. Ollama's own default (2048) is the opposite
 *    failure: it silently truncates every real chat.
 *  - 16384 is the balance: 8× Ollama's default (no silent truncation for
 *    normal chats/RAG), yet a modest KV footprint that fits a 12 GB card.
 *  - Power users who know their VRAM set `contextWindowOverride` in Settings;
 *    that wins and can go all the way to the model's real maximum.
 */
export const DEFAULT_CONTEXT_CAP = 16384

/**
 * The cap for a turn that carries the TOOL CATALOGUE, which is every Agent and
 * Coding turn. A chat turn starts with a persona and a question. An agent turn
 * starts with every tool definition, in every round, and only then gets to the
 * work.
 *
 * Measured on the installed 2.6.2 build, 2026-08-06, Coding + Ollama + hermes:
 * the 30 builtin tools are 35087 characters of system prompt, and Ollama's own
 * `prompt_eval_count` put system plus user at 8488 tokens before a single
 * output token. Against DEFAULT_CONTEXT_CAP that is 52% of the window gone at
 * rest, so a run reached step 18 of a 30 step plan, compacted, and started the
 * plan again from step 1 because the pinned task survives compaction and the
 * progress does not. Twice, same shape both times.
 *
 * Why raising it is safe, measured on the RTX 3060 12 GB the cap was written
 * for, qwen2.5-coder:14b:
 *   num_ctx 16384 -> 12 GB, `ollama ps` reports 16%/84% CPU/GPU
 *   num_ctx 32768 -> 15 GB, `ollama ps` reports 34%/66% CPU/GPU
 * Neither OOMs. Ollama offloads layers to system RAM instead of failing, so
 * the cap was never buying the crash protection its comment promises. It buys
 * speed. For a chat that is the right trade and DEFAULT_CONTEXT_CAP keeps it.
 * For an agent run it is the wrong one: a slower run finishes, a run that
 * restarts its own plan at step 18 never does.
 *
 * The model's real maximum still wins downward, and a user override still wins
 * outright. A chat turn and an agent turn on the same model therefore send
 * two different windows, and Ollama loads the model again between them. That
 * is the price of the two surfaces having genuinely different needs, and it
 * is the ONLY reload left: everything else follows one of the two, see
 * `ollamaWindowFor` below and `ollamaNumCtx` in api/ollama.ts.
 */
export const AGENT_CONTEXT_CAP = 32768

/**
 * @param modelMax   the model's real/trained context length (0/undefined = unknown)
 * @param override   user's explicit contextWindowOverride (0 = no override)
 * @param cap        the ceiling to apply (DEFAULT_CONTEXT_CAP for chat,
 *                   AGENT_CONTEXT_CAP for a turn carrying the tool catalogue)
 * @returns the context window to actually use — never exceeds the model's real
 *          max (when known), never silently sits at Ollama's 2048 default.
 */
export function effectiveContextWindow(
  modelMax: number | undefined,
  override?: number,
  cap: number = DEFAULT_CONTEXT_CAP,
): number {
  if (override && override > 0) return override
  // An UNKNOWN real maximum falls back to the conservative default, never to
  // `cap`. Asking a model for more room than it was trained on makes Ollama
  // extrapolate RoPE and costs quality, so the larger agent ceiling is only
  // ever reached by a model that has told us it can take it.
  const max = modelMax && modelMax > 0 ? modelMax : DEFAULT_CONTEXT_CAP
  return Math.min(max, cap)
}

/**
 * The two windows an Ollama model is ever asked to run with.
 *
 *   - `chat`:  a turn that starts with a persona and a question. Chat, Voice,
 *              the comparison view.
 *   - `agent`: a turn that carries the tool catalogue. Agent mode, the Code
 *              tab, a workflow.
 *
 * Nothing else may pick a window. A call nobody sees (memory extraction, a
 * title, a prompt rewrite, a sub-agent, the screen model, a compaction) names
 * neither and is sent the window the model was last sent, so it can never be
 * the reason Ollama loads a model again.
 */
export type WindowUse = 'chat' | 'agent'

/**
 * What a caller may say about the window of one call. `backend-default` sends
 * none at all and is for exactly one case: a call that follows a turn the app
 * did not send itself (the phone talks to the backend through the remote
 * bridge and names no window).
 */
export type WindowChoice = WindowUse | 'backend-default'

/** An agent turn never runs below this, so a picture fed back for a look still fits. */
export const AGENT_CONTEXT_FLOOR = 8192

/**
 * The num_ctx of one use on one Ollama model. Pure; the one caller that sends
 * it is `ollamaNumCtx` (api/ollama.ts), and whoever only shows or budgets the
 * number calls this with the same three values.
 */
export function ollamaWindowFor(use: WindowUse, modelMax: number | undefined, override?: number): number {
  if (override && override > 0) return override
  if (use === 'chat') return effectiveContextWindow(modelMax, 0)
  return Math.max(effectiveContextWindow(modelMax, 0, AGENT_CONTEXT_CAP), AGENT_CONTEXT_FLOOR)
}
