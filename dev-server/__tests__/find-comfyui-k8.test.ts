/**
 * K8 (GH #134): `detect_all_comfyui_installs` / `find_comfyui`
 * had no dev-server route at all. `find_comfyui` was even mapped in
 * endpointMap (src/api/backend.ts) already, pointing at a path
 * `dev-server/comfy.ts` never registered. ComfyStep.tsx's auto-detect tried
 * both, got a 404 (an HTML page, not JSON) from each, and settled on
 * `{ found: false }`, so onboarding stayed stuck on "Install ComfyUI" even
 * with ComfyUI installed and running on :8188. Independent of --host/LAN.
 *
 * Real filesystem, but only the throwaway COMFYUI_PATH: `findComfyUI` also
 * looks into the home folder and scans the drive roots, so on a machine that
 * has a ComfyUI of its own the "nothing found" cases found that one (two red
 * tests on a Windows machine with `%USERPROFILE%\\ComfyUI`). Everything
 * outside the throwaway folder reads as absent here. Real handler
 * (registerComfyControlRoutes, the function dev-server/index.ts calls),
 * real HTTP. `isComfyRunning()` is stubbed at the network boundary
 * (`fetch`) since "is a real ComfyUI answering on :8188" is not this test's
 * concern.
 *
 * Run: npx vitest run dev-server/__tests__/find-comfyui-k8.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerComfyControlRoutes, createComfyLauncher } from '../comfy'
import { routeHolen } from './echte-anfrage'
import { anfrage } from './echte-anfrage'

const sichtbar = vi.hoisted(() => ({ wurzel: '' }))

vi.mock('fs', async (importOriginal) => {
  const echt = await importOriginal<typeof import('fs')>()
  const innen = (pfad: unknown) => sichtbar.wurzel === '' || String(pfad).startsWith(sichtbar.wurzel)
  const existsSync: typeof echt.existsSync = (pfad) => innen(pfad) && echt.existsSync(pfad)
  const readdirSync = ((pfad: Parameters<typeof echt.readdirSync>[0], ...rest: unknown[]) =>
    innen(pfad) ? Reflect.apply(echt.readdirSync, echt, [pfad, ...rest]) : []) as typeof echt.readdirSync
  return { ...echt, existsSync, readdirSync }
})

let dir = ''
const vorherEnv = process.env.COMFYUI_PATH

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lu-find-comfyui-'))
  sichtbar.wurzel = dir
})

afterEach(() => {
  if (vorherEnv === undefined) delete process.env.COMFYUI_PATH
  else process.env.COMFYUI_PATH = vorherEnv
  sichtbar.wurzel = ''
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const comfy = createComfyLauncher()
const findComfyuiHandler = routeHolen((r) => registerComfyControlRoutes(r, comfy), '/local-api/find-comfyui')
const detectAllHandler = routeHolen((r) => registerComfyControlRoutes(r, comfy), '/local-api/detect-all-comfyui-installs')

describe('/local-api/find-comfyui', () => {
  it('reports found:false when COMFYUI_PATH has no main.py', async () => {
    process.env.COMFYUI_PATH = dir // empty dir, no main.py
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const res = await anfrage(findComfyuiHandler, { url: '/' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ found: false, path: null, complete: false })
  })

  it('reports found:true, complete:true when ComfyUI is actually reachable', async () => {
    writeFileSync(join(dir, 'main.py'), '# comfy\n')
    process.env.COMFYUI_PATH = dir
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const res = await anfrage(findComfyuiHandler, { url: '/' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ found: true, path: dir, complete: true })
  })

  it('reports found:true, complete:true from a built venv even when not currently running', async () => {
    writeFileSync(join(dir, 'main.py'), '# comfy\n')
    mkdirSync(join(dir, 'venv'))
    process.env.COMFYUI_PATH = dir
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const res = await anfrage(findComfyuiHandler, { url: '/' })
    expect(res.json()).toEqual({ found: true, path: dir, complete: true })
  })

  it('reports found:true, complete:false for a bare clone with neither a venv nor a running process (P14 carcass)', async () => {
    writeFileSync(join(dir, 'main.py'), '# comfy\n')
    process.env.COMFYUI_PATH = dir
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const res = await anfrage(findComfyuiHandler, { url: '/' })
    expect(res.json()).toEqual({ found: true, path: dir, complete: false })
  })
})

describe('/local-api/detect-all-comfyui-installs', () => {
  it('answers an empty array, not a 404, when nothing is found', async () => {
    process.env.COMFYUI_PATH = dir
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const res = await anfrage(detectAllHandler, { url: '/' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('answers a one-entry array shaped like the Rust ComfyInstallChoice', async () => {
    writeFileSync(join(dir, 'main.py'), '# comfy\n')
    process.env.COMFYUI_PATH = dir
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const res = await anfrage(detectAllHandler, { url: '/' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual([
      { path: dir, complete: true, has_embedded_python: false, source: 'scan' },
    ])
  })
})
