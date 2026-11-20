/**
 * R5-67: intents.ts had drifted from Web's labels for the shared intents.
 * Web is authoritative for "Enhance" (the upscale intent); Desktop keeps its
 * own longer "Edit / Image to Image" label for 'edit' on purpose (GH D#86,
 * see the comment on that entry), that one is NOT supposed to match Web.
 * Web's separate 'video_upscale' intent is a feature decision for the owner, not
 * a label fix, and stays out of both this test and this repo's INTENTS.
 *
 * Reads the web app as source text
 * (a sibling checkout, same pattern as the R5-9 and R5-4 parity tests) rather
 * than importing it, since it is a Next.js file this bundle cannot import.
 *
 * B5 (review-w2ui.md, 18.09.2026): this used to read Web's source through a
 * fixed seven-`..` `__dirname` path, which only resolves from
 * `lu-301-wt/<name>/`. Outside that (the main checkout, Windows, CI) the
 * `readFileSync` at module scope threw and took the whole file down. Same
 * fix as `katalog-paritaet-web.test.ts`: only LU_WEB_REPO says where the web
 * checkout is (web-checkout.ts). Not set, the guard is skipped with a line on
 * stderr. Set to something that is not a web checkout, it fails.
 *
 * Run: LU_WEB_REPO=/path/to/web npx vitest run \
 *   src/components/create/experimental/__tests__/intent-label-parity.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webCheckout } from '../../../../lib/__tests__/web-checkout'
import { INTENT_MAP } from '../intents'

const REL_PATH = 'apps/web/components/create/experimental/intents.ts'
const WEB = webCheckout('intent-label-parity', [REL_PATH])
const WEB_SRC = WEB ? readFileSync(resolve(WEB, REL_PATH), 'utf8') : ''

/** Pulls label/short for one intent id out of Web's source, without importing it. */
function webLabelShort(id: string): { label: string; short: string } | null {
  const at = WEB_SRC.indexOf(`id: '${id}'`)
  if (at === -1) return null
  const line = WEB_SRC.slice(at, WEB_SRC.indexOf('\n', at))
  const label = /label:\s*'([^']*)'/.exec(line)?.[1]
  const short = /short:\s*'([^']*)'/.exec(line)?.[1]
  return label && short ? { label, short } : null
}

describe.skipIf(!WEB)('R5-67: shared intents keep the same label/short as Web', () => {
  const sharedIds = ['image', 'removebg', 'video', 'animate', 'upscale', 'eraser', 'character', 'lipsync', 'music', 'extend', 'motion']

  it.each(sharedIds)('%s matches Web word for word', (id) => {
    const web = webLabelShort(id)
    expect(web, `Web has no entry for ${id}`).not.toBeNull()
    expect(INTENT_MAP[id as keyof typeof INTENT_MAP].label).toBe(web!.label)
    expect(INTENT_MAP[id as keyof typeof INTENT_MAP].short).toBe(web!.short)
  })

  it('"upscale" specifically reads "Enhance Image" / "Enhance", not the old "Upscale"', () => {
    expect(INTENT_MAP.upscale.label).toBe('Enhance Image')
    expect(INTENT_MAP.upscale.short).toBe('Enhance')
  })

  it('NEGATIVE CONTROL: "edit" is a deliberate exception and does NOT match Web', () => {
    const web = webLabelShort('edit')
    expect(web?.label).toBe('Edit Image')
    expect(INTENT_MAP.edit.label).toBe('Edit / Image to Image')
    expect(INTENT_MAP.edit.label).not.toBe(web?.label)
    // The short forms do agree, this is a label-only divergence.
    expect(INTENT_MAP.edit.short).toBe(web?.short)
  })

  it('intent ids are unchanged by the rename, so a saved gallery/createStore state must not strand', () => {
    expect(INTENT_MAP.upscale.label).toBeDefined()
    expect(Object.keys(INTENT_MAP)).toContain('upscale')
    expect(Object.keys(INTENT_MAP)).not.toContain('enhance')
  })

  it("Web's video_upscale is a feature decision, not part of Desktop's intent table", () => {
    expect(Object.keys(INTENT_MAP)).not.toContain('video_upscale')
    expect(webLabelShort('video_upscale')).not.toBeNull()
  })
})
