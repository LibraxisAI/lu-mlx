/**
 * @vitest-environment jsdom
 *
 * F4 (DIE-301-LISTE.md / proof/1-engine-modelle.md): the MLX install path
 * pulls models straight from huggingface.co and, before this fix, said
 * nothing about a token helping. This pins the hint text on that path AND
 * that it stays off the sibling ComfyUI panel (the only OTHER local-media
 * install surface, shown instead of this one on non-Mac hosts, see
 * SettingsPage.tsx's `isMlxImageHost()` branch): a hint that leaked onto a
 * download path that never talks to huggingface.co with the app's own
 * apply_hf_token flow would be worse than none, it would point the user at
 * a setting that does not apply there.
 *
 * The four comparison numbers the list also asks for (with/without token,
 * with/without HF_HUB_DISABLE_XET=1) need a real Hugging Face token against
 * the live Hub; this build did not create or read one (no credential
 * handling here), so the hint text carries no number and the measurement
 * stays open, see bau/w2lane.md.
 *
 * Run: npx vitest run src/components/settings/__tests__/mlx-hf-token-hint.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../../../api/mlx-image', () => ({
  mlxStatus: vi.fn().mockResolvedValue({ installed: false, running: false, port: 0 }),
  listMlxImageModels: vi.fn().mockResolvedValue([]),
  installMlxImageModel: vi.fn(),
  getMlxImageInstallStatus: vi.fn().mockResolvedValue({ status: 'idle', logs: [], error: null }),
  cancelMlxImageInstall: vi.fn(),
  deleteMlxImageModel: vi.fn(),
  installMlxImageEngine: vi.fn(),
  getMlxImageEngineStatus: vi.fn().mockResolvedValue({ status: 'idle', logs: [], error: null }),
  mlxUnload: vi.fn(),
  hfTokenPresent: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../../api/mlx-video', () => ({
  getVideoStatus: vi.fn().mockResolvedValue({
    available: false, appleSilicon: true, mlxInstalled: false, mlxVersion: null,
    pythonBin: null, modelsRoot: '', outputsRoot: '', installedModels: [], running: false,
  }),
  listVideoModels: vi.fn().mockResolvedValue([]),
  installMlxVideo: vi.fn(),
  getMlxInstallStatus: vi.fn().mockResolvedValue({ status: 'idle', logs: [], error: null }),
  installVideoModel: vi.fn(),
  getModelInstallStatus: vi.fn().mockResolvedValue({ status: 'idle', logs: [], error: null }),
  cancelVideoModelInstall: vi.fn(),
  deleteVideoModel: vi.fn(),
}))

import { MlxMediaSettings } from '../MlxMediaSettings'

afterEach(cleanup)

const HINT = /Anonymous downloads can be slower or rate limited/i

describe('F4: der HF-Token-Hinweis im MLX-Installationsweg', () => {
  it('erscheint im MLX-Medienpanel', async () => {
    render(createElement(MlxMediaSettings))
    expect(await screen.findByText(HINT)).toBeTruthy()
  })

  it('nennt keine Zahl, das Messen blieb offen (kein Token in diesem Bau)', async () => {
    render(createElement(MlxMediaSettings))
    const node = await screen.findByText(HINT)
    expect(node.textContent).not.toMatch(/\d/)
  })

  it('GEGENPROBE: der Hinweis steht NICHT im ComfyUI-Panel, dem einzigen anderen lokalen Medien-Installationsweg', () => {
    // Strukturell statt gerendert: `ComfyUISettings` lebt als eigene
    // Funktion in SettingsPage.tsx (kein eigenes Modul) und zieht ein
    // eigenes Geflecht an Backend-Zustand mit, das hier nicht aufgebaut
    // werden soll. Der Quelltext der Funktion selbst beantwortet die Frage
    // robust genug: "steht der MLX-Text (oder ein Verweis auf Hugging Face)
    // auch hier". ComfyUI installiert nie von huggingface.co, sondern von
    // der ComfyUI-Registry/Civitai, der Hinweis waere dort schlicht falsch.
    const seite = readFileSync(resolve(__dirname, '..', 'SettingsPage.tsx'), 'utf-8')
    const zeilen = seite.split('\n')
    const start = zeilen.findIndex((z) => z.startsWith('export function ComfyUISettings'))
    expect(start).toBeGreaterThan(-1)
    // Naechste Funktion auf oberster Ebene beendet den Ausschnitt.
    const endeRelativ = zeilen.slice(start + 1).findIndex((z) => /^(export )?function [A-Za-z]/.test(z))
    const quelle = zeilen.slice(start, start + 1 + endeRelativ).join('\n')

    expect(quelle).not.toMatch(HINT)
    expect(quelle).not.toMatch(/huggingface/i)
  })
})
