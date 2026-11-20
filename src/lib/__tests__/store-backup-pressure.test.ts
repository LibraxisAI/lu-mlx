import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({ backendCall: (...args: unknown[]) => backendCall(...args) }))

describe('backups under a slow disk', () => {
  beforeEach(() => {
    vi.resetModules()
    backendCall.mockReset()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('never sends a second full-history payload while a backup is unfinished', async () => {
    const completions: (() => void)[] = []
    backendCall.mockImplementation(() => new Promise<void>(resolve => completions.push(resolve)))
    const backup = await import('../store-backup')
    const { idbStorage } = await import('../idbStorage')
    const history = 'A'.repeat(1024 * 1024)
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < 12; i++) {
      await idbStorage.setItem('chat-conversations', JSON.stringify({ history, turn: i }))
      pending.push(backup.backupStoresIfChanged())
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const whileBlocked = backendCall.mock.calls.length
    // Release all work so even the pre-fix failure leaves no dangling promises.
    for (let i = 0; i < 16; i++) {
      completions.splice(0).forEach(resolve => resolve())
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await Promise.all(pending)
    expect(whileBlocked).toBe(1)
    expect(backendCall.mock.calls.length).toBeLessThanOrEqual(2)
    const latest = JSON.parse(backendCall.mock.calls.at(-1)![1].data)
    expect(JSON.parse(latest['chat-conversations']).turn).toBe(11)
  })

  it('an update waits behind the active backup and writes the newest state last', async () => {
    let finishFirst!: () => void
    backendCall.mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
    backendCall.mockResolvedValue(undefined)
    const backup = await import('../store-backup')
    localStorage.setItem('chat-settings', 'old')
    const first = backup.backupStoresIfChanged()
    await new Promise(resolve => setTimeout(resolve, 0))
    localStorage.setItem('chat-settings', 'new')
    const update = backup.backupStoresNow()
    await new Promise(resolve => setTimeout(resolve, 0))
    const whileBlocked = backendCall.mock.calls.length
    finishFirst()
    await first
    expect(await update).toBe(true)
    expect(whileBlocked).toBe(1)
    expect(JSON.parse(backendCall.mock.calls.at(-1)![1].data)['chat-settings']).toBe('new')
  })

  it('still backs up when the small localStorage restore marker cannot be written', async () => {
    backendCall.mockResolvedValue(undefined)
    const backup = await import('../store-backup')
    localStorage.setItem('chat-settings', 'keep this')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(await backup.backupStoresNow()).toBe(true)
    expect(JSON.parse(backendCall.mock.calls.at(-1)![1].data)['chat-settings']).toBe('keep this')
  })

  it('coalesces the close-time flush with an active backup instead of copying the history again', async () => {
    let finishFirst!: () => void
    backendCall.mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
    backendCall.mockResolvedValue(undefined)
    const backup = await import('../store-backup')
    localStorage.setItem('chat-settings', 'old')
    await backup.backupStoresIfChanged()
    localStorage.setItem('chat-settings', 'new')
    backup.flushSyncStoreBackup()
    expect(backendCall).toHaveBeenCalledTimes(1)
    finishFirst()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(backendCall).toHaveBeenCalledTimes(2)
    expect(JSON.parse(backendCall.mock.calls.at(-1)![1].data)['chat-settings']).toBe('new')
  })

  it('holds the backup while the chat store is about to shrink, and never reads the store meanwhile', async () => {
    backendCall.mockResolvedValue(undefined)
    const backup = await import('../store-backup')
    const hold = await import('../backup-hold')
    const { idbStorage } = await import('../idbStorage')
    await idbStorage.setItem('chat-conversations', JSON.stringify({ inline: 'A'.repeat(1024) }))
    hold.holdBackup('test')
    expect(await backup.backupStoresIfChanged()).toBe('held-back')
    expect(backup.flushSyncStoreBackup()).toBe('held-back')
    expect(backendCall).not.toHaveBeenCalled()
    hold.releaseBackup('test')
    expect(await backup.backupStoresIfChanged()).toBe('written')
    expect(backendCall).toHaveBeenCalledOnce()
  })
})
