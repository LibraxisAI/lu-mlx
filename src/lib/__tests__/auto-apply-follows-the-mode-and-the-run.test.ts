/**
 * Bug hunt 01.10.2026 (C5). Auto-apply asked settings.codexStageMode, a switch
 * the modes had replaced: Ask stages whatever it says. With the switch off the
 * opt-in never fired; with it on, a Bypass run applied what an EARLIER Ask run
 * had left in the queue for the user to review. The switch decided nothing
 * else any more and is gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../../api/backend', () => ({ backendCall: vi.fn(async () => ({ status: 'saved' })) }))
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ addMessage: vi.fn(), conversations: [] }) },
}))

import { backendCall } from '../../api/backend'
import { applyAllStagedChanges } from '../staged-apply'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { DEFAULT_SETTINGS } from '../constants'

const CHAT = 'chat-c5'
const call = backendCall as unknown as ReturnType<typeof vi.fn>
const written = () => call.mock.calls.filter(([c]) => c === 'fs_write').map(([, a]) => (a as { path: string }).path)

beforeEach(() => {
  call.mockClear()
  useStagedChangesStore.getState().clear(CHAT)
  useAgentModeStore.setState({ workspaceSlugs: { [CHAT]: 'slug-c5' } })
})

describe('auto-apply', () => {
  it('lands only what this run staged, and leaves the earlier review queue alone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useStagedChangesStore.getState().stage(CHAT, { path: 'earlier.ts', oldContent: '', newContent: 'a', diff: '' })
    vi.setSystemTime(5_000)
    const runStart = Date.now()
    useStagedChangesStore.getState().stage(CHAT, { path: 'this-run.ts', oldContent: '', newContent: 'b', diff: '' })
    vi.useRealTimers()

    const res = await applyAllStagedChanges(CHAT, runStart)
    expect(written()).toEqual(['this-run.ts'])
    expect(res.applied).toEqual(['this-run.ts'])
    expect(useStagedChangesStore.getState().list(CHAT).map((c) => c.path)).toEqual(['earlier.ts'])
  })

  it('follows the mode, not a settings switch', () => {
    const codex = readFileSync(resolve(__dirname, '../../hooks/useCodex.ts'), 'utf8')
    expect(codex).toContain('if (knobs.stageWrites && settings.codexAutoApply && convId && !isRunStopped(convId)) {')
    expect(codex).toMatch(/\.filter\(\(c\) => c\.stagedAt >= turnStartMs\)/)
    expect(codex).toContain('applyAllStagedChanges(convId, turnStartMs)')
  })

  it('the dead switch is gone, the opt-in is always reachable', () => {
    expect('codexStageMode' in DEFAULT_SETTINGS).toBe(false)
    const page = readFileSync(resolve(__dirname, '../../components/settings/SettingsPage.tsx'), 'utf8')
    expect(page).not.toContain('codexStageMode')
    expect(page).toContain('Auto-apply changes staged in Ask mode when the run finishes')
  })
})
