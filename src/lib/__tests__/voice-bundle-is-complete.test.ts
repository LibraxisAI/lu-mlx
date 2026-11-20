/**
 * Voice needs files that are not compiled code: the Python sidecar, its lock
 * files, the dictation server and the capture worklet. Each system has its own
 * bundle list, and a file missing from one of them only shows on that system,
 * as a voice engine that does not start.
 *
 * So the three lists are read here and laid over the files on disk: every
 * module of the sidecar must be carried, to the place Rust looks for it, and
 * the tests of the sidecar must stay out.
 *
 * Run: npx vitest run src/lib/__tests__/voice-bundle-is-complete.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const tauriDir = resolve(root, 'src-tauri')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const config = (name: string) => JSON.parse(read(`src-tauri/${name}`)) as { bundle?: { resources?: string[] | Record<string, string> } }

/** Source file to the path it has inside the bundle's resource directory. */
function bundled(resources: string[] | Record<string, string>): Map<string, string> {
  const pairs: [string, string][] = Array.isArray(resources) ? resources.map((source) => [source, '']) : Object.entries(resources)
  const out = new Map<string, string>()
  for (const [source, target] of pairs) {
    const star = source.match(/^(.*)\/\*(\.[a-z]+)?$/)
    if (!star) {
      // The list form keeps the path, the map form names the target.
      out.set(source, Array.isArray(resources) ? source : target)
      continue
    }
    const [, dir, ext = ''] = star
    // The engine binaries of another system are fetched in CI and are not here.
    if (!existsSync(resolve(tauriDir, dir))) continue
    for (const file of readdirSync(resolve(tauriDir, dir), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(ext)) continue
      out.set(`${dir}/${file.name}`, Array.isArray(resources) ? `${dir}/${file.name}` : `${target}${file.name}`)
    }
  }
  return out
}

const SIDECAR = 'resources/voice_loop'
const modules = readdirSync(resolve(tauriDir, SIDECAR, 'lu_voice_loop')).filter((name) => name.endsWith('.py'))

const systems: [string, string[] | Record<string, string>][] = [
  // macOS has no resource list of its own and takes the one of the base file.
  ['macOS', config('tauri.conf.json').bundle!.resources!],
  ['Windows', config('tauri.windows.conf.json').bundle!.resources!],
  ['Linux', config('tauri.linux.conf.json').bundle!.resources!],
]

describe('the voice sidecar travels in every bundle', () => {
  it('macOS really uses the base list', () => {
    expect(config('tauri.macos.conf.json').bundle?.resources).toBeUndefined()
  })

  it('the sidecar has the modules this test expects to guard', () => {
    // A rename would otherwise empty the checks below without failing them.
    for (const name of ['__init__.py', '__main__.py', 'pipeline.py', 'speech.py', 'tools.py', 'commands.py', 'latency.py']) {
      expect(modules).toContain(name)
    }
  })

  it('every module imported inside the sidecar is a file of the sidecar', () => {
    const imported = new Set<string>()
    for (const name of modules) {
      for (const match of read(`src-tauri/${SIDECAR}/lu_voice_loop/${name}`).matchAll(/^from \.(\w+) import /gm)) imported.add(`${match[1]}.py`)
    }
    expect(imported.size).toBeGreaterThan(5)
    for (const name of imported) expect(modules).toContain(name)
  })

  for (const [system, resources] of systems) {
    describe(system, () => {
      const files = bundled(resources)

      it('carries every Python module of the sidecar to where Rust looks for it', () => {
        for (const name of modules) {
          expect(files.get(`${SIDECAR}/lu_voice_loop/${name}`), name).toBe(`${SIDECAR}/lu_voice_loop/${name}`)
        }
      })

      it('carries the package lock, the model list and the Python list', () => {
        for (const name of ['requirements.txt', 'models.json', 'python.json']) {
          expect(files.get(`${SIDECAR}/${name}`), name).toBe(`${SIDECAR}/${name}`)
        }
      })

      it('carries the dictation server', () => {
        expect(files.get('resources/whisper_server.py')).toBe('resources/whisper_server.py')
      })

      it('leaves the tests and the development requirements of the sidecar at home', () => {
        const stray = [...files.keys()].filter((source) => source.startsWith(`${SIDECAR}/tests`) || source.endsWith('requirements-dev.txt') || source.endsWith('requirements.in'))
        expect(stray).toEqual([])
      })
    })
  }

  it('Rust looks for the sidecar below the same folder', () => {
    expect(read('src-tauri/src/commands/voice_loop/layout.rs')).toContain(`pub const SIDECAR_RESOURCE_PATH: &str = "${SIDECAR}";`)
  })
})

describe('the capture worklet travels with the frontend', () => {
  it('is a file below public, which the build copies next to the app', () => {
    expect(existsSync(resolve(root, 'public/voice/capture-worklet.js'))).toBe(true)
    expect(config('tauri.conf.json')).toMatchObject({ build: { frontendDist: '../dist' } })
  })

  it('is loaded from exactly that place', () => {
    expect(read('src/api/voice-media.ts')).toContain("new URL('voice/capture-worklet.js', document.baseURI)")
  })
})
