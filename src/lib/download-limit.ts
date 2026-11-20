// The download speed limit lives in Rust, next to the one loop every model
// file LU fetches runs through (commands/download.rs, do_download). Settings
// holds the number; this hands it over at boot and whenever it changes.
import { backendCall, isTauri } from '../api/backend'
import { log } from './logger'
import { useSettingsStore } from '../stores/settingsStore'

/** A typed value as the setting stores it: a number of MB/s, 0 for none. */
export function parseDownloadLimit(raw: string): number {
  const n = Number.parseFloat(raw.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0
}

export async function syncDownloadLimit(mbPerSec: number): Promise<void> {
  if (!isTauri()) return
  try {
    await backendCall('set_download_limit', { mbPerSec: Math.max(0, mbPerSec || 0) })
  } catch (err) {
    log.warn('download_limit.sync_failed', { err })
  }
}

/** At boot: the Rust side starts at no limit on every launch, so it gets the
 *  stored number now and again on every change, including a Reset. */
export function startDownloadLimitSync(): Promise<void> {
  useSettingsStore.subscribe((s, prev) => {
    if (s.settings.downloadLimitMBps !== prev.settings.downloadLimitMBps) {
      void syncDownloadLimit(s.settings.downloadLimitMBps)
    }
  })
  return syncDownloadLimit(useSettingsStore.getState().settings.downloadLimitMBps)
}
