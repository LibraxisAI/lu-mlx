/**
 * What a bundle card should say: Installed, Installing, Retry or Get.
 *
 * GH #113 on Windows 11 with an RTX 5070 Ti: a video download
 * failed midway, he retried, and afterwards the model "doesn't shown in the
 * installed section and for some reason every model in the list shown retry".
 *
 * The download store is keyed by FILENAME, and bundles share files. Seven of
 * the thirteen video bundles ship the same umt5_xxl_fp8_e4m3fn_scaled text
 * encoder and six the same wan_2.1_vae, so one attempt on one bundle writes
 * rows that every other bundle in the list then reads as if they were about
 * itself:
 *
 *   - one error row on a shared file made every bundle carrying that filename
 *     count as NOT installed, even the ones sitting complete on disk, because
 *     the error veto ran before the disk answer;
 *   - one FINISHED shared file made every bundle carrying it look half
 *     downloaded, which is the Retry button on every card in the list.
 *
 * So the rule is: the disk is the only source that speaks about this bundle
 * and nothing else, and a download row only says something about this bundle
 * when it is about a file this bundle is still missing.
 *
 * Pure on purpose. The component holds the store and the disk verdicts; the
 * decision is here where it can be proven without either.
 */

/** The one field of a download row any of this depends on. */
export interface DownloadRow {
  status: string
}

/** A bundle file, narrowed to what the state machine reads. */
export interface BundleFileRef {
  filename?: string
}

type Rows = Record<string, DownloadRow | undefined>

/** Files of the bundle that actually have a name to look up. */
function named(files: BundleFileRef[]): string[] {
  return files.map((f) => f.filename).filter((n): n is string => !!n)
}

/**
 * Installed.
 *
 * `diskInstalled` is checkBundlesInstalled's verdict: every file present at
 * its full size AND visible to the running ComfyUI. It is asked FIRST because
 * it is the only signal that is about this bundle alone. The old order let a
 * stale error row on a shared filename overrule a bundle that was completely
 * and verifiably on disk.
 */
export function bundleIsComplete(
  files: BundleFileRef[],
  downloads: Rows,
  diskInstalled: boolean,
): boolean {
  if (diskInstalled) return true
  const names = named(files)
  // Session fallback: everything this bundle needs finished in this run. An
  // error row cannot pass this either, so the old separate veto bought
  // nothing here beyond the false negative it caused.
  return names.length > 0 && names.every((n) => downloads[n]?.status === 'complete')
}

/** Something of this bundle is moving right now. */
export function bundleIsDownloading(files: BundleFileRef[], downloads: Rows): boolean {
  return named(files).some((n) => {
    const s = downloads[n]?.status
    return s === 'downloading' || s === 'connecting'
  })
}

/**
 * Retry, meaning this bundle really did stop halfway.
 *
 * An explicit error row still counts, whatever it is on: a shared file that
 * cannot be fetched blocks this bundle just as much as its own.
 *
 * The half-downloaded case is the one that had to change. "Some files
 * complete, not all" is true of every bundle that merely shares a finished
 * file with an installed sibling, which is how one good install turned the
 * whole list red. It only means something when the part that is MISSING was
 * attempted too, so there is a row for a file that is not complete.
 */
export function bundleHasErrors(
  files: BundleFileRef[],
  downloads: Rows,
  diskInstalled: boolean,
): boolean {
  const names = named(files)
  if (names.some((n) => downloads[n]?.status === 'error')) return true
  if (diskInstalled) return false
  const done = names.filter((n) => downloads[n]?.status === 'complete')
  if (done.length === 0 || done.length === names.length) return false
  return names.some((n) => {
    const row = downloads[n]
    return row !== undefined && row.status !== 'complete'
  })
}

/** One gibibyte, the unit the catalog's `sizeGB` and every size message use. */
const GIB = 1_073_741_824

/** The fields of a catalog file the sums below read. */
export interface SizedFile {
  downloadUrl?: string
  filename?: string
  subfolder?: string
  sizeGB?: number
  sizeBytes?: number
}

/** A catalog file's size in bytes: the exact count where the catalog has it,
 *  the rounded `sizeGB` otherwise, 0 when it states neither. */
export function catalogFileBytes(file: SizedFile): number {
  if (file.sizeBytes != null) return file.sizeBytes
  return file.sizeGB ? Math.round(file.sizeGB * GIB) : 0
}

/**
 * How many bytes this bundle still has to fetch, and where they land.
 *
 * Pure, so the sum can be tested without a drive. Files already on disk are
 * left out: re-checking space for a file that is not going to be fetched would
 * refuse installs that fit perfectly well, and a card that announces them
 * promises a download three times the real one (the box, 03.10.2026: "Get ·
 * 16.1 GB" for one file of 8.7 GB). The sum is taken over the files' own byte
 * counts, not over the bundle's hand-written total. `totalSizeGB` is the
 * fallback when the per-file sizes are missing: a rough number is a far better
 * plan than planning for nothing.
 */
export function bundleBytesToFetch(
  bundle: { files: SizedFile[]; totalSizeGB: number },
  installed: ReadonlySet<string>,
): { bytes: number; subfolder?: string; files: number } {
  const pending = bundle.files.filter(
    f => f.downloadUrl && f.filename && f.subfolder && !installed.has(f.filename),
  )
  if (pending.length === 0) return { bytes: 0, files: 0 }
  const known = pending.reduce((sum, f) => sum + catalogFileBytes(f), 0)
  // Not one file states a size: fall back to the bundle total, minus nothing,
  // because we cannot tell which part of it is already there.
  const bytes = known > 0 ? known : (bundle.totalSizeGB || 0) * GIB
  return { bytes: Math.round(bytes), subfolder: pending[0].subfolder, files: pending.length }
}

const NOTHING_ON_DISK: ReadonlySet<string> = new Set()

/** What a bundle card announces: the whole bundle, and the part of it a click
 *  on Get will really fetch. `present` counts the files that are there already. */
export function bundleGetPlan(
  bundle: { files: SizedFile[]; totalSizeGB: number },
  onDisk: ReadonlySet<string>,
): { totalBytes: number; totalFiles: number; fetchBytes: number; fetchFiles: number; present: number } {
  const sized = bundleBytesToFetch(bundle, NOTHING_ON_DISK)
  // A bundle whose files carry no download address has nothing to sum: the
  // catalog's own total and file count are all there is to say.
  const total = sized.files > 0
    ? sized
    : { bytes: Math.round((bundle.totalSizeGB || 0) * GIB), files: bundle.files.length }
  const pending = bundleBytesToFetch(bundle, onDisk)
  // Nothing left to fetch and the card still offers Get: the files are on disk
  // and ComfyUI does not list them. The click re-checks all of them, so the
  // card names the whole bundle.
  const fetch = pending.files > 0 ? pending : total
  return {
    totalBytes: total.bytes,
    totalFiles: total.files,
    fetchBytes: fetch.bytes,
    fetchFiles: fetch.files,
    present: total.files - fetch.files,
  }
}
