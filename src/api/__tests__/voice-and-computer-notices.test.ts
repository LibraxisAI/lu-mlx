/**
 * Voice and computer control bring their own third-party parts: a Python
 * environment that the setup installs, voice models, a handful of crates.
 * `third-party/VOICE-AND-COMPUTER-NOTICES.md` lists them with their licenses.
 *
 * A list like that goes stale silently: someone bumps a pin and the notice
 * still names the old version, or a new package arrives and nobody reads its
 * license. So the pins are laid over the list here. A failure means: read the
 * license of what changed at its source, then update the list.
 *
 * Run: npx vitest run src/api/__tests__/voice-and-computer-notices.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const notices = read('third-party/VOICE-AND-COMPUTER-NOTICES.md')
const voice = 'src-tauri/resources/voice_loop'

describe('the notices for Voice and computer control match what is pinned', () => {
  it('names every pinned Python package with its version and a license', () => {
    const pins = [...read(`${voice}/requirements.txt`).matchAll(/^([A-Za-z0-9_.-]+)==([^\s;\\]+)/gm)].map((m) => [m[1], m[2]])
    expect(pins.length).toBeGreaterThan(80)
    const missing = pins.filter(([name, version]) => !new RegExp(`^\\| ${name.replace(/[.+]/g, '\\$&')} \\| ${version.replace(/[.+]/g, '\\$&')} \\| \\S`, 'm').test(notices))
    expect(missing).toEqual([])
  })

  it('shows the credit lines of the models word for word', () => {
    const models = JSON.parse(read(`${voice}/models.json`)) as { models: { name: string; license: string; revision: string; attribution?: string }[] }
    const credits = models.models.filter((model) => model.attribution)
    expect(credits.length).toBeGreaterThan(0)
    for (const model of models.models) {
      expect(notices).toContain(`| ${model.name} | ${model.license} |`)
      expect(notices).toContain(model.revision.slice(0, 12))
      if (model.attribution) expect(notices).toContain(model.attribution)
    }
  })

  it('names the Python runtime as pinned', () => {
    const python = JSON.parse(read(`${voice}/python.json`)) as { version: string; license: string; release: string }
    expect(notices).toContain(`CPython ${python.version}, license ${python.license}`)
    expect(notices).toContain(`release ${python.release}`)
  })

  it('names the crates of computer control with the version in Cargo.lock', () => {
    const lock = read('src-tauri/Cargo.lock')
    for (const crate of ['enigo', 'xcap', 'uiautomation', 'tauri-plugin-global-shortcut', 'global-hotkey', 'x11rb']) {
      const version = lock.match(new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`))?.[1]
      expect(version, crate).toBeTruthy()
      expect(notices).toMatch(new RegExp(`^\\| ${crate} \\| ${version!.replace(/\./g, '\\.')} \\| \\S`, 'm'))
    }
  })

  it('names the screen model of the catalog and where its file comes from', () => {
    const catalog = read('src/api/discover.ts')
    expect(catalog).toContain("HF('mradermacher/Holo-3.1-9B-GGUF'")
    expect(notices).toContain('| Holo 3.1 9B (GGUF, Q4_K_M, with projector) | Apache-2.0 | https://huggingface.co/Hcompany/Holo-3.1-9B, conversion from https://huggingface.co/mradermacher/Holo-3.1-9B-GGUF |')
  })

  it('lists every npm package of the voice client at the version that installs', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> }
    const client = read('third-party/ASTRA-CLIENT-NOTICES.md')
    const sections = [...client.matchAll(/^## (node_modules\/\S+) (\S+) /gm)]
    expect(sections.length).toBeGreaterThan(5)
    for (const [, path, version] of sections) expect(lock.packages[path]?.version, path).toBe(version)
    for (const name of ['@pipecat-ai/websocket-transport', '@daily-co/daily-js', '@protobuf-ts/runtime', 'x-law']) {
      expect(notices).toContain(`| ${name} | ${lock.packages[`node_modules/${name}`].version} |`)
    }
  })
})
