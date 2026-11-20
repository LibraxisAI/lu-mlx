import { expect, test } from '@playwright/test'
import { appModules, type AppWindow } from './support/ui'

test('real memory writes confirm snapshots in order and reject a stale sync guard', async ({ page }) => {
  await page.goto('/e2e/memory-sensitive-proof.html')
  await appModules(page, ['/src/stores/memoryStore.ts', '/src/lib/memory-persistence.ts'])
  const result = await page.evaluate(async () => {
    const { useMemoryStore } = (window as unknown as AppWindow).__APP__['/src/stores/memoryStore.ts'] as typeof import('../src/stores/memoryStore')
    const { flushMemoryPersist } = (window as unknown as AppWindow).__APP__['/src/lib/memory-persistence.ts'] as typeof import('../src/lib/memory-persistence')
    const id = useMemoryStore.getState().addMemory({ type: 'user', title: 'Queue proof', content: 'Original queue fact', description: '', tags: [], source: 'manual' })
    const first = flushMemoryPersist()
    useMemoryStore.getState().updateMemory(id, { content: 'Updated queue fact' })
    const original = await first
    const updated = await flushMemoryPersist()
    const expected = useMemoryStore.getState().entries
    const guarded = flushMemoryPersist(() => useMemoryStore.getState().entries === expected)
    useMemoryStore.getState().removeMemory(id)
    let rejected = false
    try { await guarded } catch { rejected = true }
    const deleted = await flushMemoryPersist()
    return { original, updated, rejected, deleted }
  })
  expect(result.original).toContain('Original queue fact')
  expect(result.original).not.toContain('Updated queue fact')
  expect(result.updated).toContain('Updated queue fact')
  expect(result.rejected).toBe(true)
  expect(result.deleted).not.toContain('queue fact')
  await page.reload()
  await page.getByRole('button', { name: 'Preview AI memory context' }).click()
  await expect(page.locator('#result')).toHaveText('No eligible memories')
})
