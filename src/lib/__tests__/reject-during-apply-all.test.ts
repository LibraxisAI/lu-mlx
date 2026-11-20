/**
 * Bug hunt 01.10.2026 (C2). "Apply all" walks a snapshot of the queue, one
 * write after the other. A Reject clicked while the first file was being
 * written removed the second from the list, and the loop wrote it anyway: the
 * file the user had just turned down landed on disk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({ backendCall: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ addMessage: vi.fn(), conversations: [] }) },
}))

import { backendCall } from '../../api/backend'
import { applyAllStagedChanges, applyStagedChange } from '../staged-apply'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { useAgentModeStore } from '../../stores/agentModeStore'

const call = backendCall as unknown as ReturnType<typeof vi.fn>
const CHAT = 'chat-c2'
const store = () => useStagedChangesStore.getState()
const stage = (path: string) =>
  store().stage(CHAT, { path, oldContent: '', newContent: `content of ${path}`, diff: '' })
const written = () => call.mock.calls.filter(([cmd]) => cmd === 'fs_write').map(([, a]) => (a as { path: string }).path)

describe('a Reject during Apply all', () => {
  beforeEach(() => {
    call.mockReset()
    store().clear(CHAT)
    useAgentModeStore.setState({ workspaceSlugs: { [CHAT]: 'slug-c2' } })
  })

  it('keeps the rejected file off the disk', async () => {
    stage('one.py')
    stage('two.py')
    call.mockImplementation(async (cmd: string, args: { path: string }) => {
      // The user clicks Reject on two.py while one.py is being written.
      if (cmd === 'fs_write' && args.path === 'one.py') {
        const two = store().list(CHAT).find((c) => c.path === 'two.py')!
        store().remove(CHAT, two.id)
      }
      return { status: 'saved' }
    })

    const res = await applyAllStagedChanges(CHAT)

    expect(written()).toEqual(['one.py'])
    expect(res.applied).toEqual(['one.py'])
    expect(res.failed).toEqual([])
  })

  it('also when the Reject lands while that same file is being read for the drift check', async () => {
    stage('late.py')
    const change = store().list(CHAT)[0]
    call.mockImplementation(async (cmd: string) => {
      if (cmd !== 'fs_write') store().remove(CHAT, change.id)
      return { status: 'saved' }
    })

    expect(await applyStagedChange(CHAT, change)).toBe(false)
    expect(written()).toEqual([])
  })
})
