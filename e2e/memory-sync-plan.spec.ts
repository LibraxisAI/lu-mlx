import { expect, test } from '@playwright/test'
import { appModules, type AppWindow } from './support/ui'

test('browser WebCrypto plans conflicts and forgetting without retaining private copies', async ({ page }) => {
  await page.goto('/e2e/memory-sensitive-proof.html')
  await appModules(page, ['/src/lib/memory-sync-plan.ts'])
  const result = await page.evaluate(async () => {
    const { planMemorySync, syncMemoryHash } = (window as unknown as AppWindow).__APP__['/src/lib/memory-sync-plan.ts']
    const memory = { id: 'one', type: 'user', title: 'Fact', description: '', content: 'Original', tags: [], source: 'manual', createdAt: 1, updatedAt: 1 }
    const baseline = { one: { revision: 1, hash: await syncMemoryHash(memory) } }
    const local = { ...memory, content: 'Private local edit' }
    const remote = { memory_id: 'one', revision: 2, deleted: false, payload: { ...memory, content: 'Private remote edit' }, updated_at: '2026-09-09T00:00:00Z' }
    const conflict = await planMemorySync([local], baseline, [remote])
    const deletion = await planMemorySync([local], baseline, [{ ...remote, deleted: true, payload: null }])
    const pull = await planMemorySync([memory], baseline, [remote])
    return { hash: baseline.one.hash, conflict, deletion, pulledContent: pull.pull[0].memory.content }
  })
  expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.conflict.conflicts).toEqual([{ id: 'one', reason: 'both-edited' }])
  expect(result.deletion.remove).toEqual([{ id: 'one', baseline: { revision: 2, hash: null } }])
  expect(JSON.stringify([result.conflict, result.deletion])).not.toContain('Private')
  expect(result.pulledContent).toBe('Private remote edit')
})
