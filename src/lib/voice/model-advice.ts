// The one calm line the empty Voice surface may show about the chat model.
//
// Voice talks to the model that is selected in Chat, and it hands that model
// tools (files, web, shell, the screen). Two kinds of models do that badly: a
// model that takes no tools at all, and a small one. Measured in the real
// Windows build on 07.10.2026 with 23 spoken requests each: Qwen 3.5 9B
// called the right tool in 13 of 13 tool requests, its abliterated variant
// in 12 of 13. Nothing below 7B was measured, so the line is advice, not a
// block: the session starts either way.

import { resolveToolSupport } from '../tool-support'
import { paramSizeB } from '../silent-model-calls'

/** Below this many billion parameters the line is shown. */
export const VOICE_MIN_PARAMS_B = 7

/** A local model the catalog offers and that was measured with Voice. */
export const VOICE_RECOMMENDED_MODEL = 'Qwen 3.5 9B'

export interface VoiceModelFacts {
  /** The model as the picker names it, with its provider prefix. Null when none is selected. */
  name: string | null
  /** `supports_tools` from the provider's model list, when it says. */
  supportsTools?: boolean
  /** "8.95B", "494.03M": what a local server reports. */
  parameterSize?: string
}

/** Billions of parameters, from what the server reports or from the model's name. */
export function voiceModelParamsB(facts: VoiceModelFacts): number | null {
  const reported = /^\s*(\d+(?:\.\d+)?)\s*([bm])\s*$/i.exec(facts.parameterSize ?? '')
  if (reported) {
    const n = Number(reported[1])
    return reported[2].toLowerCase() === 'm' ? n / 1000 : n
  }
  return facts.name ? paramSizeB(facts.name) : null
}

/** The line, or null when the selected model needs none. */
export function voiceModelAdvice(facts: VoiceModelFacts): string | null {
  if (!facts.name) return null
  // The voice engine has no text protocol for tools: only a model that takes
  // them natively gets any (api/voice-brain.ts).
  if (resolveToolSupport({ name: facts.name, supportsTools: facts.supportsTools }) !== 'native') {
    return `This model cannot use tools, so Voice can only talk with it. A local model such as ${VOICE_RECOMMENDED_MODEL} can also work with files, the web and the screen.`
  }
  const size = voiceModelParamsB(facts)
  if (size !== null && size < VOICE_MIN_PARAMS_B) {
    return `Small models often miss tool calls. Voice works best with a local model from ${VOICE_MIN_PARAMS_B}B up, such as ${VOICE_RECOMMENDED_MODEL}.`
  }
  return null
}
