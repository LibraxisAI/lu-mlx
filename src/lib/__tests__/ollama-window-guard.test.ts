/**
 * The guard: nobody but api/ollama.ts decides the window of an Ollama request.
 *
 * Ollama loads a model again for every request that names another num_ctx
 * than the one it is loaded with. For months each caller worked the number
 * out by itself (or left it out), and each new caller was a new chance for a
 * full model load nobody asked for. Now `ollamaNumCtx` is the one source, and
 * this test reads the source tree so that it stays the only one:
 *
 *   1. `num_ctx` is written in exactly one file.
 *   2. Only three files send a request that runs or loads a model on Ollama,
 *      and each of them takes its window from the one source.
 *   3. A caller cannot hand the provider a number: the option is gone.
 *   4. Only a turn a person started names a use (`chat` or `agent`). A new
 *      file that names one fails here until it is added on purpose; a call
 *      nobody sees must name none.
 *   5. Only the remote bridge asks for no window at all.
 *
 * What these rules mean on the wire is proven with the real callers in
 * api/__tests__/one-window-per-ollama-model.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Code only: a comment may name anything. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
}

const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split('\\').join('/'), text: code(path) }))
const matching = (pattern: RegExp) => files.filter((f) => pattern.test(f.text)).map((f) => f.file).sort()

describe('the window of an Ollama request has one source', () => {
  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.file === 'api/ollama.ts')).toBe(true)
  })

  it('num_ctx is written in api/ollama.ts and nowhere else', () => {
    // A value given to the key, in an object or by assignment. A type
    // (`num_ctx?: number`) and a read (`params.num_ctx)`) are neither.
    const writes = /(?<![?\w])num_ctx\s*:(?!\s*(number|string)\b)|\.num_ctx\s*=(?!=)|\[['"]num_ctx['"]\]\s*=(?!=)/
    expect(matching(writes)).toEqual(['api/ollama.ts'])
  })

  it('only three files run or load a model on Ollama, each with the window from the one source', () => {
    const senders = matching(/(ollamaUrl|this\.apiUrl|apiUrl)\(\s*['"]\/(chat|generate)['"]\s*\)/)
    expect(senders).toEqual(['api/ollama.ts', 'api/providers/ollama-provider.ts', 'lib/ollama-stream-tools.ts'])
    for (const file of senders) {
      const text = files.find((f) => f.file === file)!.text
      expect(text, file).toMatch(/ollamaWindowOption\(/)
    }
    // In the provider and the tool stream every request body gets it: as
    // many window lookups as there are bodies.
    const provider = files.find((f) => f.file === 'api/providers/ollama-provider.ts')!.text
    expect(provider.match(/const body: OllamaChatRequest = \{/g)).toHaveLength(provider.match(/await ollamaWindowOption\(model, options\?\.window\)/g)?.length ?? 0)
    const toolStream = files.find((f) => f.file === 'lib/ollama-stream-tools.ts')!.text
    expect(toolStream.match(/const body: OllamaChatRequest = \{/g)).toHaveLength(toolStream.match(/await ollamaWindowOption\(modelId, options\.window\)/g)?.length ?? 0)
    // In api/ollama.ts the two loads carry it; the unload (`keep_alive: 0`)
    // loads nothing and carries none.
    const api = files.find((f) => f.file === 'api/ollama.ts')!.text
    const generates = api.split('ollamaUrl("/generate")').slice(1).map((rest) => rest.slice(0, 260))
    expect(generates).toHaveLength(3)
    expect(generates.filter((g) => /options: window/.test(g))).toHaveLength(2)
    expect(generates.filter((g) => /keep_alive: 0 \}/.test(g))).toHaveLength(1)
  })

  it('no caller can hand over a number: the option is gone', () => {
    const types = files.find((f) => f.file === 'api/providers/types.ts')!.text
    expect(types).not.toMatch(/contextWindow\?:/)
    expect(types).toMatch(/window\?: WindowChoice/)
    // And nobody passes one on the off chance.
    expect(matching(/\bcontextWindow:\s*(numCtx|agentCtx|effectiveCtx|sentWindow|turnWindow|settings\.contextWindowOverride)/)).toEqual([])
  })

  it('only a turn a person started names a use', () => {
    const namesAUse = /\bwindow:\s*'(chat|agent)'|ollamaNumCtx\([^)]*,\s*'(chat|agent)'\)|reloadOllamaWithWindow\(/
    expect(matching(namesAUse)).toEqual([
      // Defines reloadOllamaWithWindow.
      'api/ollama.ts',
      // Voice: a chat that is spoken.
      'api/voice-brain.ts',
      // The context menu in the header reloads with the window of the surface it sits on.
      'components/chat/ContextDropdown.tsx',
      // The comparison view: two chat turns side by side.
      'hooks/useABCompare.ts',
      // Agent mode.
      'hooks/useAgentChat.ts',
      // Chat.
      'hooks/useChat.ts',
      // The Code tab.
      'hooks/useCodex.ts',
      // A workflow.
      'lib/workflow-engine.ts',
    ])
  })

  it('only the remote bridge asks for no window at all', () => {
    expect(matching(/window:\s*'backend-default'/)).toEqual(['components/layout/AppShell.tsx'])
  })
})
