/**
 * The CivitAI API key in Settings has a consumer on the Mac (persona walk of
 * the Mac app, 09.10.2026, Fund 25).
 *
 * The setting says "Used for the CivitAI search on the Models page". When the
 * walk was made the Mac's Model Manager had no CivitAI search and no LoRA
 * rail, so the field set nothing. The LoRA rail of the Mac brought the search,
 * and with it the sentence became true. This test holds the chain together:
 * if the rail loses its search, the setting is an orphan again.
 *
 * Run: npx vitest run src/components/settings/__tests__/civitai-key-has-a-consumer-on-the-mac.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf-8')

describe('the CivitAI key on the Mac', () => {
  it('the setting promises the search on the Models page', () => {
    expect(read('settings/CivitaiApiKeySetting.tsx').replace(/\s+/g, ' ')).toContain('Used for the CivitAI search on the Models page and for the downloads it starts.')
  })

  it('the LoRA rail of the Mac has that search', () => {
    const lane = read('models/MacLoraLane.tsx')
    expect(lane).toContain("import { CivitaiSearchPanel } from './CivitaiSearchPanel'")
    expect(lane).toContain('<CivitaiSearchPanel')
  })

  it('the search sends the key the setting stores', () => {
    const setting = read('settings/CivitaiApiKeySetting.tsx')
    const panel = read('models/CivitaiSearchPanel.tsx')
    expect(setting).toContain('useWorkflowStore((s) => s.civitaiApiKey)')
    expect(panel).toContain('useWorkflowStore.getState().civitaiApiKey')
  })
})
