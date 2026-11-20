import { expect, it } from 'vitest'
import { ONBOARDING_MODELS } from '../constants'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../api/discover'

// Both picks are abliterated since 2026-10-01 (the owner, after a refusal report).
const textCatalog = () => [...getMainstreamTextModels(), ...getUncensoredTextModels()]

it('uses an existing catalog model meeting the 7B minimum with exact download integrity', () => {
  const starter = ONBOARDING_MODELS.find(m => m.name === 'qwen2.5-7b')
  expect(starter).toBeDefined()
  const catalog = textCatalog().find(model => model.filename === starter!.filename)
  expect(catalog).toBeDefined()
  expect(catalog!.tags).toContain('7B')
  expect(starter!.downloadUrl).toBe(catalog!.downloadUrl)
  expect(starter!.filename).toMatch(/abliterated/i)
  expect(starter!.expectedBytes).toBe(4683073920)
  expect(starter!.sha256).toBe('da9272f09cd51d27aaadf37c1a2a3e079763682688aa1601d7406062b0caa5aa')
  expect(Math.round(starter!.sizeGB * 1_073_741_824)).toBe(starter!.expectedBytes)
  expect(starter!.description).not.toMatch(/runs on anything|instant|30 seconds/i)
})

// Second onboarding pick, added so the wizard offers an agent-capable model
// above the 9B floor getRecommendedAgentModels() names as where tool calls
// start holding together. Repo and filename come from the Discover catalog
// entry (api/discover.ts, getUncensoredTextModels, name 'Qwen 3.5 9B Abliterated'), not
// typed twice, so the two cannot drift apart.
//
// sizeGB is NOT pinned against the catalog's number here: the catalog writes
// a rounded display figure (5), this entry needs the byte-exact one for
// download integrity (see the next test), the same split the 7B entry
// already has between its catalog row and its own `expectedBytes`.
it('the second onboarding pick matches the Discover catalog entry it is drawn from', () => {
  const nineB = ONBOARDING_MODELS.find(m => m.name === 'qwen3.5-9b')
  expect(nineB).toBeDefined()
  const catalog = textCatalog().find(model => model.name === 'Qwen 3.5 9B Abliterated')
  expect(catalog).toBeDefined()
  expect(nineB!.downloadUrl).toBe(catalog!.downloadUrl)
  expect(nineB!.filename).toBe(catalog!.filename)
  expect(catalog!.tags).toContain('9B')
  expect(catalog!.agent).toBe(true)
  // This IS read now: ModelsStep.tsx renders an "Agent-ready" tag on any
  // model with `agent: true` (the Discover page's ModelTiles.tsx filters on
  // the same field for its catalog rows). Not a dead flag on either side.
  expect(nineB!.agent).toBe(true)
})

// Byte-exact download integrity from the HuggingFace LFS metadata for this
// repo (api/models/mradermacher/Qwen3.5-9B-abliterated-GGUF/tree/main), read
// on 2026-10-01: 5627045216 bytes for Qwen3.5-9B-abliterated.Q4_K_M.gguf. Mirrors
// the check the 7B starter already has above, so the built-in engine path
// can verify this download the same way it verifies that one
// (ModelsStep.tsx passes `expectedBytes`/`sha256` through to
// `startModelDownloadToPath`).
it('the 9B download is pinned to the byte-exact size and SHA-256 of the repo', () => {
  const nineB = ONBOARDING_MODELS.find(m => m.name === 'qwen3.5-9b')!
  expect(nineB.expectedBytes).toBe(5627045216)
  expect(nineB.sha256).toBe('19fadda28b2f4bd939fb4590db978acf8f0d6da274ac7ea8f7f2cdc92f1470a4')
  expect(Math.round(nineB.sizeGB * 1_073_741_824)).toBe(nineB.expectedBytes)
})

// vramGB is measured, not guessed (lu-301/STAND-BAU.md:258: RTX 3060, all 32
// layers offloaded, "6,1 GB VRAM"; corroborated by MODELL-UND-SKRIPT.md's
// nvidia-smi reading). The number is not re-typed here as a second copy to
// compare against, that would just check the field equals itself under a
// different name. Instead this checks the thing that could actually drift:
// that the human-readable `vram` and `description` text are read FROM
// `vramGB`, so a future edit to one cannot silently leave the other behind.
it('vram and description text are derived from vramGB, not a separately hand-typed number', () => {
  const nineB = ONBOARDING_MODELS.find(m => m.name === 'qwen3.5-9b')!
  expect(nineB.vram).toContain(String(nineB.vramGB))
  expect(nineB.description).toContain(String(nineB.vramGB))
})

it('both onboarding entries are present and distinct', () => {
  expect(ONBOARDING_MODELS.length).toBeGreaterThanOrEqual(2)
  const names = ONBOARDING_MODELS.map(m => m.name)
  expect(names).toContain('qwen2.5-7b')
  expect(names).toContain('qwen3.5-9b')
})
