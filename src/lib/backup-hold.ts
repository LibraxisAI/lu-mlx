/**
 * Holds the native store backup while a store is about to shrink.
 *
 * A history saved by a build before the attachment store carries every image
 * inline. The first backup tick after launch used to read that value out of
 * IndexedDB a second time, serialise it into the snapshot and hand it to IPC:
 * three more copies of the largest thing in the renderer, on top of the one
 * hydration just made. The chat store holds the backup until its first write
 * has moved the images out, so the backup copies the small form instead.
 *
 * Nothing is lost while held: store_backup.json keeps the previous snapshot,
 * which already contains everything the held store had at launch.
 */
const holds = new Set<string>()

export function holdBackup(reason: string): void { holds.add(reason) }
export function releaseBackup(reason: string): void { holds.delete(reason) }
export function isBackupHeld(): boolean { return holds.size > 0 }
