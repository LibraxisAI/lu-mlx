import { expect, test } from '@playwright/test'
import { appModules, type AppWindow } from './support/ui'

test('an aborted native transaction never reports a successful commit or backup event', async ({ page }) => {
  await page.goto('/e2e/memory-sensitive-proof.html')
  await appModules(page, ['/src/lib/idbStorage.ts'])
  const result = await page.evaluate(async () => {
    const { compareAndSetIdbItem, idbStorage, onIdbWrite } = (window as unknown as AppWindow).__APP__['/src/lib/idbStorage.ts']
    const key = 'sync-abort-proof'
    await compareAndSetIdbItem(key, null, 'original', () => true)
    let events = 0
    const unsubscribe = onIdbWrite((k: string) => { if (k === key) events++ })
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, entryKey) {
      const request = originalPut.call(this, value, entryKey)
      if (entryKey === key) this.transaction.abort()
      return request
    }
    let rejected = false
    try { await compareAndSetIdbItem(key, 'original', 'uncommitted', () => true) } catch { rejected = true } finally {
      IDBObjectStore.prototype.put = originalPut
      unsubscribe()
    }
    return { rejected, events, stored: await idbStorage.getItem(key) }
  })
  expect(result).toEqual({ rejected: true, events: 0, stored: 'original' })
})

test('atomic sync storage has one race winner and survives reload with its baseline', async ({ page }) => {
  await page.goto('/e2e/memory-sensitive-proof.html')
  await appModules(page, ['/src/lib/idbStorage.ts'])
  const result = await page.evaluate(async () => {
    const { compareAndSetIdbItem, idbStorage, onIdbWrite } = (window as unknown as AppWindow).__APP__['/src/lib/idbStorage.ts']
    const key = 'sync-atomic-proof'
    const first = JSON.stringify({ entries: ['first'], baseline: 1 })
    const second = JSON.stringify({ entries: ['second'], baseline: 2 })
    const events: string[] = []
    const unsubscribe = onIdbWrite((k: string, v: string) => { if (k === key) events.push(v) })
    const outcomes = await Promise.all([
      compareAndSetIdbItem(key, null, first, () => true),
      compareAndSetIdbItem(key, null, second, () => true),
    ])
    const stored = await idbStorage.getItem(key)
    const revoked = await compareAndSetIdbItem(key, stored, 'revoked', () => false)
    let aborted = false
    try { await compareAndSetIdbItem(key, stored, 'aborted', () => { throw new Error('private detail') }) } catch (error) {
      aborted = error instanceof Error && error.message === 'Could not commit synchronized memory storage'
    }
    unsubscribe()
    return { outcomes, stored, revoked, aborted, events, final: await idbStorage.getItem(key) }
  })
  expect(result.outcomes.filter(Boolean)).toHaveLength(1)
  expect(result.events).toEqual([result.stored])
  expect(result.revoked).toBe(false)
  expect(result.aborted).toBe(true)
  expect(result.final).toBe(result.stored)
  await page.reload()
  await appModules(page, ['/src/lib/idbStorage.ts'])
  const restored = await page.evaluate(() => {
    return (window as unknown as AppWindow).__APP__['/src/lib/idbStorage.ts'].idbStorage.getItem('sync-atomic-proof')
  })
  expect(restored).toBe(result.stored)
})

test('sync storage refuses legacy and malformed stored data without replacing it', async ({ page }) => {
  await page.goto('/e2e/memory-sensitive-proof.html')
  await appModules(page, ['/src/lib/idbStorage.ts'])
  const result = await page.evaluate(async () => {
    const { compareAndSetIdbItem } = (window as unknown as AppWindow).__APP__['/src/lib/idbStorage.ts']
    localStorage.setItem('sync-legacy-proof', 'legacy data')
    let legacyRejected = false
    try { await compareAndSetIdbItem('sync-legacy-proof', null, 'replacement', () => true) } catch { legacyRejected = true }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('locally-uncensored-store', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Fixture database unavailable'))
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put({ original: true }, 'sync-malformed-proof')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(new Error('Fixture transaction failed'))
    })
    let malformedRejected = false
    try { await compareAndSetIdbItem('sync-malformed-proof', null, 'replacement', () => true) } catch { malformedRejected = true }
    const preserved = await new Promise<unknown>((resolve) => {
      const request = db.transaction('kv').objectStore('kv').get('sync-malformed-proof')
      request.onsuccess = () => resolve(request.result)
    })
    db.close()
    return { legacyRejected, malformedRejected, preserved, legacy: localStorage.getItem('sync-legacy-proof') }
  })
  expect(result).toEqual({ legacyRejected: true, malformedRejected: true, preserved: { original: true }, legacy: 'legacy data' })
})
