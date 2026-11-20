/**
 * Starting the files of one chat model as ONE download.
 *
 * A model with image input is two files, the model and its image part, and a
 * split model is many. Whoever starts them has to do the same five things for
 * each file, and until October 2026 three places did them by hand and each
 * forgot something else: the Models page started the image part without its
 * byte count's twin, the digest; the split download passed no digest at all;
 * onboarding never fetched the part.
 *
 * So there is one door. Every file gets its retry record (address, folder,
 * size, digest) BEFORE it starts, the files are filed under one name in the
 * download list so they read as one job with one progress and one total, a
 * file that is on disk already is marked complete instead of being waited for,
 * and a start the backend refused is an error here and not a row that never
 * appears.
 */

import { startModelDownloadToPath, type PlannedDownload } from './discover'
import { useDownloadStore } from '../stores/downloadStore'

/**
 * Start every file of `plan` into `destDir`, filed under `groupName`.
 *
 * Throws on the first file the backend refuses. Files started before it keep
 * running: they are part of the model either way, and the caller's error line
 * names what failed.
 */
export async function startPlannedDownload(plan: readonly PlannedDownload[], destDir: string, groupName: string): Promise<void> {
  const store = useDownloadStore.getState()
  if (plan.length > 1) store.setBundleGroup(groupName, plan.map((f) => f.filename))
  for (const f of plan) {
    store.setMeta(f.filename, f.url, 'gguf', destDir, { expectedBytes: f.expectedBytes, sha256: f.sha256 })
    const answer = await startModelDownloadToPath(f.url, destDir, f.filename, f.expectedBytes, f.sha256)
    if (answer?.status === 'exists') {
      // On disk already and the host confirmed its size. No transfer starts,
      // so no row would ever appear, and a caller waiting for the file would
      // wait for nothing.
      useDownloadStore.getState().markComplete(f.filename)
    } else if (answer?.status === 'error') {
      throw new Error(answer.error || `${f.filename} could not be started`)
    }
  }
  useDownloadStore.getState().startPolling()
}
