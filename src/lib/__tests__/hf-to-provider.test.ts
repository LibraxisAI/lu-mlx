/**
 * hf-to-provider — GGUF quant extraction, Ollama HF refs, and the
 * sharded/incompatible-pull classifier.
 *
 * Regression focus (a user, Discord 2026-06-07): unsloth "UD"
 * dynamic quants (Q4_K_XL / Q4_K_XS) were not recognised, so the Ollama HF
 * reference dropped the quant tag entirely.
 */
import { describe, it, expect } from 'vitest'
import { extractGgufQuant, hfUrlToOllamaRef, hfUrlToTreePath, isShardedOrIncompatibleGguf } from '../hf-to-provider'

describe('extractGgufQuant', () => {
  it('reads classic K-quants', () => {
    expect(extractGgufQuant('model-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(extractGgufQuant('model.Q5_K_S.gguf')).toBe('Q5_K_S')
    expect(extractGgufQuant('model_Q3_K_L.gguf')).toBe('Q3_K_L')
  })
  it('reads unsloth UD dynamic quants (a reported regression)', () => {
    expect(extractGgufQuant('gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf')).toBe('Q4_K_XL')
    expect(extractGgufQuant('model-UD-Q4_K_XS.gguf')).toBe('Q4_K_XS')
  })
  it('reads bare K-quants, Q*_0/1, IQ, and float types', () => {
    expect(extractGgufQuant('model-Q6_K.gguf')).toBe('Q6_K')
    expect(extractGgufQuant('model-Q8_0.gguf')).toBe('Q8_0')
    expect(extractGgufQuant('model-IQ4_XS.gguf')).toBe('IQ4_XS')
    expect(extractGgufQuant('model-F16.gguf')).toBe('F16')
  })
  it('reads the quant through a multi-part shard suffix (2.5.8 catalog regression)', () => {
    // Caught live on the ship exe: the 155 GB "DeepSeek V4 Flash" card offered
    // the repo's 80.9 GB Q2 set in the confirm dialog, because the shard
    // counter after the quant made extractGgufQuant return undefined and the
    // resolver fell back to the repo's first quant group.
    expect(extractGgufQuant('DeepSeek-V4-Flash-UD-Q4_K_XL-00001-of-00005.gguf')).toBe('Q4_K_XL')
    expect(extractGgufQuant('GLM-5.2-UD-Q2_K_XL-00001-of-00007.gguf')).toBe('Q2_K_XL')
    expect(extractGgufQuant('GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf')).toBe('Q3_K_M')
    expect(extractGgufQuant('Kimi-K2.7-Code-UD-Q2_K_XL-00008-of-00008.gguf')).toBe('Q2_K_XL')
  })
  it('returns undefined when no quant token is present', () => {
    expect(extractGgufQuant('model.gguf')).toBeUndefined()
    expect(extractGgufQuant('not-a-gguf.txt')).toBeUndefined()
    // a bare shard counter is not a quant
    expect(extractGgufQuant('model-00001-of-00002.gguf')).toBeUndefined()
  })
})

describe('hfUrlToTreePath', () => {
  it('returns the path behind /resolve/<rev>/, folder included', () => {
    expect(hfUrlToTreePath('https://huggingface.co/a/b/resolve/main/model-Q4_K_M.gguf')).toBe('model-Q4_K_M.gguf')
    expect(hfUrlToTreePath('https://huggingface.co/a/b/resolve/main/UD-Q3_K_M/GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf'))
      .toBe('UD-Q3_K_M/GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf')
  })
  it('drops the query and undoes percent encoding', () => {
    expect(hfUrlToTreePath('https://huggingface.co/a/b/resolve/main/my%20model.gguf?download=true')).toBe('my model.gguf')
  })
  it('returns null for an address that is not a HuggingFace file address', () => {
    expect(hfUrlToTreePath('https://example.com/model.gguf')).toBeNull()
  })
})

describe('hfUrlToOllamaRef', () => {
  it('builds hf.co/<user>/<repo>:<quant> from a HF blob URL + filename', () => {
    const url = 'https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'
    // With the XL fix the quant tag is now preserved instead of dropped.
    expect(hfUrlToOllamaRef(url, 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'))
      .toBe('hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_XL')
  })
  // Asked on 2026-10-08: the registry behind hf.co answers a file name tag
  // with exactly that file (RVN-Q4_K_M-multilingual.gguf, 16547400224 bytes),
  // the bare reference with the older Qwen3.8-27B-Heretic-Q4_K_M.gguf
  // (16547400032 bytes), and `:Q4_K_P` with HTTP 400.
  it('tags the file name when the name does not end on a recognised quant', () => {
    const heretic = 'https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/resolve/main/RVN-Q4_K_M-multilingual.gguf'
    expect(hfUrlToOllamaRef(heretic, 'RVN-Q4_K_M-multilingual.gguf'))
      .toBe('hf.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF:RVN-Q4_K_M-multilingual.gguf')
    const kp = 'https://huggingface.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/resolve/main/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf'
    expect(hfUrlToOllamaRef(kp, 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf'))
      .toBe('hf.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf')
    const dated = 'https://huggingface.co/huihui-ai/Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF/resolve/main/DeepSeek-V4-Flash-Q4_K-0731.gguf'
    expect(hfUrlToOllamaRef(dated, 'DeepSeek-V4-Flash-Q4_K-0731.gguf'))
      .toBe('hf.co/huihui-ai/Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF:DeepSeek-V4-Flash-Q4_K-0731.gguf')
    expect(hfUrlToOllamaRef('https://huggingface.co/acme/Some-Model-GGUF/resolve/main/model.gguf', 'model.gguf'))
      .toBe('hf.co/acme/Some-Model-GGUF:model.gguf')
  })
  it('stays tag-less for a quant-less file inside a folder, where the name tag is unproven', () => {
    const url = 'https://huggingface.co/acme/Some-Model-GGUF/resolve/main/sub/model.gguf'
    expect(hfUrlToOllamaRef(url, 'model.gguf')).toBe('hf.co/acme/Some-Model-GGUF')
  })
  it('returns null for a non-HuggingFace URL', () => {
    expect(hfUrlToOllamaRef('https://example.com/model.gguf', 'model.gguf')).toBeNull()
  })
})

describe('isShardedOrIncompatibleGguf', () => {
  it('flags sharded / split / not-compatible pull errors', () => {
    expect(isShardedOrIncompatibleGguf('Error: repository is not GGUF or is not compatible with llama.cpp')).toBe(true)
    expect(isShardedOrIncompatibleGguf('model is split into multiple parts')).toBe(true)
    expect(isShardedOrIncompatibleGguf('sharded gguf not supported (ollama/ollama#5245)')).toBe(true)
  })
  it('does NOT flag a bare HTTP 400 (handled separately as out-of-date Ollama)', () => {
    expect(isShardedOrIncompatibleGguf('ollama: 400')).toBe(false)
  })
  it('does NOT flag unrelated errors', () => {
    expect(isShardedOrIncompatibleGguf('connection refused')).toBe(false)
  })
})
