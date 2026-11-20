/**
 * The repository says nothing about what runs behind the hosted service.
 *
 * The client code is public. Who serves it, what a run costs to buy, how the
 * private server repository is laid out, who reported a bug and whose home
 * folder a fixture was copied from are not, and a
 * comment is as public as a string. scripts/check-silent.mjs reads every
 * tracked text file outside docs/ for those; this suite runs it in the normal
 * gate and proves that the scan finds each kind when it is there.
 *
 * A hit is fixed by rewording the line. An entry in ALLOWED is for the rare
 * line that has to carry the word, and says why.
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED, ALLOWED_TEXT, HELD, HOME_NAME_HASHES, NOT_READ, REPORTER_HASHES, RULES, findHits, hashOf, scan, trackedFiles } from '../../../scripts/check-silent.mjs'

describe('the tracked tree', () => {
  const { hits, read } = scan()

  it('is read: the scan sees the sources, the scripts and the workflows', () => {
    // A scan that reads nothing is green for no reason.
    expect(read).toBeGreaterThan(2000)
    const files = trackedFiles()
    for (const dir of ['src/', 'src-tauri/src/', 'scripts/', 'e2e/', '.github/']) {
      expect(files.some((f) => f.startsWith(dir)), dir).toBe(true)
    }
  })

  it('carries none of the words and none of the patterns', () => {
    expect(hits.map((h) => `${h.file}:${h.line} [${h.rule}] ${h.word}`)).toEqual([])
  })
})

describe('the scan finds each kind when it is there', () => {
  // Built from pieces so that this file passes its own scan.
  const j = (...parts: string[]) => parts.join('')
  const cases: [string, string][] = [
    ['vendor', j('// ', 'Deep', 'Infra answers 422 here')],
    ['vendor', j('// the hosted ', 'Wave', 'Speed endpoint')],
    ['vendor', j('// paid through ', 'Str', 'ipe')],
    ['vendor', j('// lives on the ', 'drop', 'let')],
    ['server-path', j('// see apps', '/web/lib/chat/x.ts')],
    ['server-path', j('// (lib', '/billing/credits.ts)')],
    ['server-constant', j('// follows LENGTH_MODEL', '_USD')],
    ['migration', j('// since migr', 'ation 0047')],
    ['table', j('// a row in credit', '_topups')],
    ['money', j('// costs $', '0.04 a run')],
    ['money', j('// 1,10 U', 'SD je Lauf')],
    ['margin', j('// nie unter dem Einkaufs', 'preis')],
    ['host', j('// measured on lu', '-box')],
    ['billing-story', j('// Until 2026', '-10-09 a 409 was charged twice')],
    ['billing-story', j('// die Geld', 'falle')],
    ['mail', j('// Feedback (some.one@', 'gmail.com)')],
  ]

  it.each(cases)('%s: %s', (rule, line) => {
    expect(findHits(line, 'src/x.ts').map((h) => h.rule)).toContain(rule)
  })

  it('a handle of someone who reported a bug, from its hash alone', () => {
    // The list holds hashes, so it does not publish the names it keeps out.
    // This case adds a made-up handle to prove the lookup.
    const made = 'made_up_reporter_4711'
    REPORTER_HASHES.add(hashOf(made))
    try {
      expect(findHits(`// Discord 2026-10-01 (${made}): it broke`, 'src/x.ts').map((h) => h.rule)).toContain('reporter')
      expect(findHits(`// ${made.toUpperCase()}'s report`, 'src/x.ts').map((h) => h.rule)).toContain('reporter')
    } finally {
      REPORTER_HASHES.delete(hashOf(made))
    }
    for (const hash of REPORTER_HASHES) expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(REPORTER_HASHES.size).toBeGreaterThan(100)
  })

  it('a home folder under a real account name, from its hash alone', () => {
    const made = 'madeupaccount4711'
    HOME_NAME_HASHES.add(hashOf(made))
    try {
      const lines = [`const p = '/Users/${made}/Desktop/x.png'`, `"C:\\\\Users\\\\${made}\\\\ComfyUI"`, `in c:\\users\\${made}\\venv`, `/home/${made}.cache/x`]
      for (const line of lines) expect(findHits(line, 'src/x.test.ts').map((h) => h.rule), line).toContain('home-name')
      // The name alone is no hit, and a neutral name in a path is none either.
      expect(findHits(`// ${made} said so`, 'src/x.test.ts')).toEqual([])
    } finally {
      HOME_NAME_HASHES.delete(hashOf(made))
    }
    for (const line of ['/Users/alice/Desktop', 'C:\\Users\\user\\x', '/home/me/.config', '/Users/max.mustermann/x']) {
      expect(findHits(line, 'src/x.test.ts'), line).toEqual([])
    }
    for (const hash of HOME_NAME_HASHES) expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('a path under the name of the service, in the catalogue snapshot as anywhere else', () => {
    // The snapshot of the Create tab files its schemas under neutral keys
    // (scripts/studio-snapshot.mjs). No exception covers those files, so a
    // copy taken over by hand is caught here.
    const lines = [
      j('    "endpoint": "wave', 'speed-ai/flux-dev",'),
      j('  "wave', 'speed-ai/flux-dev": {'),
      j('    "t2": "wave', 'speed-ai/wan-2.2/t2v-720p",'),
      j('        "description": "Use a voice you trained (https://wave', 'speed.ai/models/x).",'),
    ]
    for (const file of ['studio-models.json', 'provider-schemas.json', 'provider-endpoints.json']) {
      expect(ALLOWED.some((a) => a.files.test(`src/lib/render/${file}`)), file).toBe(false)
      expect([...NOT_READ, ...HELD].some((a) => a.files.test(`src/lib/render/${file}`)), file).toBe(false)
      for (const line of lines) expect(findHits(line, `src/lib/render/${file}`).map((h) => h.rule), line).toContain('vendor')
    }
    expect(findHits('    "endpoint": "base/flux-dev",', 'src/lib/render/studio-models.json')).toEqual([])
  })

  it('leaves alone what a user picks himself and where a local model comes from', () => {
    const fine = [
      "{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }",
      "{ id: 'together', name: 'Together', baseUrl: 'https://api.together.xyz/v1' }",
      '// Ollama, LM Studio and ComfyUI are detected on their default ports',
      'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
      '// a CivitAI token for gated downloads, https://civitai.com/api/download/models/1',
      'https://www.modelscope.cn/models/Qwen/Qwen3-8B-GGUF',
      'https://registry.ollama.ai/v2/library/qwen3/manifests/8b',
      'https://github.com/ggml-org/llama.cpp/releases',
      "nativeName: 'Venice Uncensored 1.2'",
      "baseUrl: 'http://192.168.1.20:1234/v1'",
      '// 100.64.0.0/10 is where Tailscale puts a machine',
      'const stripExt = (p) => p',
      "'someone@example.com'",
    ]
    for (const line of fine) expect(findHits(line, 'src/x.ts'), line).toEqual([])
  })
})

describe('the exceptions', () => {
  it('each name a known rule and a reason', () => {
    const ids = RULES.map((r) => r.id)
    for (const entry of ALLOWED) {
      expect(ids, String(entry.files)).toContain(entry.rule)
      expect(entry.why.length, String(entry.files)).toBeGreaterThan(20)
    }
    for (const entry of [...NOT_READ, ...HELD]) expect(entry.why.length, String(entry.files)).toBeGreaterThan(20)
    expect(ALLOWED_TEXT.length).toBeLessThanOrEqual(2)
  })

  it('each still match a tracked file, so a stale one is noticed', () => {
    const files = trackedFiles()
    for (const entry of [...ALLOWED, ...NOT_READ, ...HELD]) {
      expect(files.some((f) => entry.files.test(f)), String(entry.files)).toBe(true)
    }
  })

  it('stay few', () => {
    // A new exception is a decision. This number moves with it.
    expect(ALLOWED).toHaveLength(14)
    expect(HELD).toHaveLength(1)
  })
})
