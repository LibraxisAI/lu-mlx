/**
 * Bug hunt 01.10.2026 (C8). fs_read answers a file that is not UTF-8 (Latin-1,
 * UTF-16 written by PowerShell) with `{ encoding: 'binary' }` and no content.
 * Staging read that as '' and showed the overwrite as a brand new file, and
 * Apply's drift check compared '' with '' and wrote over it. Staging now
 * refuses such a file, as file_edit already did, and Apply refuses a file
 * that is not text on disk.
 */
import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({ backendCall: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ addMessage: vi.fn(), conversations: [] }) } }))

import { backendCall } from '../../api/backend'
import { applyStagedChange } from '../staged-apply'
import { createStagedWriter } from '../../hooks/codex/staged-writes'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'

const call = backendCall as unknown as ReturnType<typeof vi.fn>
const CONV = 'conv-c8'

beforeEach(() => {
  call.mockReset()
  useStagedChangesStore.getState().clear(CONV)
})

it('staging a write over a non-UTF-8 file is refused, nothing is queued', async () => {
  const writer = createStagedWriter({
    convId: CONV, workDir: '/home/u/repo', workspaceSlug: 'slug',
    readFile: async () => ({ encoding: 'binary' }) as never,
  })
  const out = await writer.stageFileWrite({ path: 'legacy.txt', content: 'new text' })
  expect(out).toMatch(/^file_write: legacy\.txt exists but is not a UTF-8 text file/)
  expect(useStagedChangesStore.getState().list(CONV)).toHaveLength(0)
})

it('Apply does not write over a file that is not text on disk', async () => {
  useStagedChangesStore.getState().stage(CONV, { path: 'legacy.txt', oldContent: '', newContent: 'new text', diff: '' })
  call.mockImplementation(async (cmd: string) => (cmd === 'fs_read' ? { encoding: 'binary' } : { status: 'saved' }))
  const change = useStagedChangesStore.getState().list(CONV)[0]
  await expect(applyStagedChange(CONV, change)).rejects.toThrow(/not a UTF-8 text file on disk/)
  expect(call.mock.calls.some(([cmd]) => cmd === 'fs_write')).toBe(false)
})
